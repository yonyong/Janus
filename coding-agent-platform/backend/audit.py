"""审计留痕：操作日志 + Agent 调用留痕。

两块数据，两个页面，但共用一套「记录动作」，原因是一致的：

- **操作日志**（audit_logs）：谁（管理员口令 / 访问令牌 / 匿名）在什么时候、对哪个
  项目/对象做了什么。覆盖所有会改状态或泄露敏感信息的动作 —— 项目的增删改、令牌的
  签发/改期/吊销/查看原文、Agent 的增删改、需求与阶段的变更、文件写盘与删除、
  改动回退、会话创建。
- **Agent 调用留痕**（agent_invocations）：每调用一次真实 agent 就写一条，**成功与
  失败一视同仁**。记录入参、出参、项目、需求、模型、token 用量与耗时。

三条硬约束（改动前请先读）：

1. **留痕失败绝不打断业务**。记录动作整体 try/except，只告警；审计是旁路，
   不能因为写不进日志就让用户的操作失败。
2. **用独立连接写**。请求里的连接可能正处于写事务中，复用会把审计行卷进别人的事务，
   记录失败时还会被迫 rollback 掉业务数据。审计自己开连接、自己提交。
3. **失败留痕不能被锁吃掉**。路由报错时业务连接往往还握着未提交的写事务（例如唯一约束
   冲突后的 INSERT），第二条连接去写只会等到 busy_timeout 超时 —— 最该留下的那一半记录
   反而最容易丢。所以审计连接先用短 busy_timeout 快试一次，抢不到锁就把记录放进待写队列，
   等请求收尾、锁释放后由 ``drain_deferred`` 补上。见「落库」一节的说明。
4. **用量要说清真假**。CLI 不回传 usage 时按字符估算，并置 ``tokens_estimated=1``，
   接口与页面都据此标注「估算」。不要用估算值冒充真实用量。
"""
import asyncio
import contextvars
import json
import re
import sqlite3
import threading
import urllib.parse

from . import logbus as LOG
from . import repositories as R
from .db import get_conn

# 入库前的截断上限：审计要能还原发生了什么，但不该被一次超大输出撑爆
PROMPT_LIMIT = 4000
RESPONSE_LIMIT = 8000

# 来源取值：工作台会话 / Agent 一键测试 / AI 生成用例 / AI 润色需求
INVOCATION_SOURCES = ("session", "probe", "ai_cases", "ai_polish")
AUDIT_STATUSES = ("success", "failure")
INVOCATION_STATUSES = ("success", "error")

_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")


# ---------------- 纯函数（可单测，不碰库） ----------------

def mask_token(tok: str | None) -> str:
    """令牌脱敏：日志里只留可辨认的头尾，绝不落原文。

    与 app._mask 保持同样的形状，但这里各自实现一份，避免 audit 反向依赖 app。
    """
    t = tok or ""
    if not t:
        return ""
    if len(t) <= 12:
        return t[:4] + "…"
    return f"{t[:6]}…{t[-4:]}"


def estimate_tokens(text: str | None) -> int:
    """估算 token 数：中日韩 1 字 ≈ 0.7 token，其余 4 字符 ≈ 1 token。

    只在模型没回传真实 usage 时使用；调用方必须同时置 tokens_estimated=1。
    """
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    other = len(text) - cjk
    return int(round(cjk * 0.7 + other / 4.0))


# 各家 CLI / SDK 对用量字段的命名并不统一，这里全部认
_USAGE_ALIASES = {
    "prompt_tokens": ("prompt_tokens", "input_tokens", "prompttokens", "inputtokens",
                      "prompt", "input"),
    "completion_tokens": ("completion_tokens", "output_tokens", "completiontokens",
                          "outputtokens", "completion", "output"),
    "total_tokens": ("total_tokens", "totaltokens", "total", "tokens_used", "tokens used",
                     "token_usage", "tokens"),
}


def _find_number(text: str, aliases) -> int | None:
    """在文本里找 ``"key": 123`` 或 ``key: 1,234`` 形式的值。"""
    for key in aliases:
        for pat in (rf'"{key}"\s*:\s*(\d[\d,_]*)', rf'\b{key}\s*[:=]\s*(\d[\d,_]*)'):
            m = re.search(pat, text, re.I)
            if m:
                try:
                    return int(m.group(1).replace(",", "").replace("_", ""))
                except ValueError:
                    continue
    return None


def extract_usage(text: str | None) -> dict | None:
    """从 agent 输出里抠出真实的 token 用量；抠不到返回 None。

    识别的是 ``"key": 123`` / ``key: 1,234`` 这类形态，且必须是数字 —— 模型正文里提到
    「token」这个词不会误判成用量。
    """
    t = text or ""
    if not t:
        return None
    out = {k: _find_number(t, alias) for k, alias in _USAGE_ALIASES.items()}
    if all(v is None for v in out.values()):
        return None
    return {k: v for k, v in out.items() if v is not None}


def tokens_of(prompt: str | None, response: str | None, usage: dict | None = None):
    """返回 ``(prompt_tokens, completion_tokens, total_tokens, estimated)``。

    优先用调用方显式给出的 usage，其次从输出文本里自动识别；都没有才估算，
    并把 estimated 置 1，让页面能如实标注。
    """
    real = usage or extract_usage(response or "")
    if real:
        p = int(real.get("prompt_tokens") or 0)
        c = int(real.get("completion_tokens") or 0)
        t = int(real.get("total_tokens") or 0)
        if p or c or t:
            if not t:
                t = p + c
            if not p and not c and t:
                # 模型只报总数：按字符占比回填入/出参，至少让构成有数可看
                ep, ec = estimate_tokens(prompt), estimate_tokens(response)
                if ep + ec:
                    p = int(round(t * ep / (ep + ec)))
                    c = t - p
            return p, c, t, 0
    ep, ec = estimate_tokens(prompt), estimate_tokens(response)
    return ep, ec, ep + ec, 1


def model_of(agent_row) -> str:
    """从 agent 配置里解析模型名：config.model，或 args 里的 ``--model``。"""
    if not agent_row:
        return ""
    cfg = agent_row.get("config")
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:  # noqa: BLE001 - 配置是脏数据时当作没配
            cfg = {}
    if not isinstance(cfg, dict):
        return ""
    name = str(cfg.get("model") or "").strip()
    if not name:
        args = cfg.get("args") or []
        if isinstance(args, list):
            for i, a in enumerate(args):
                s = str(a)
                if s in ("--model", "-m") and i + 1 < len(args):
                    name = str(args[i + 1]).strip()
                    break
                if s.startswith("--model="):
                    name = s.split("=", 1)[1].strip()
                    break
    return name[:100]


def _err_text(exc) -> str:
    """把异常翻译成一句能进日志的话。HTTPException 的 detail 才是有用信息。"""
    detail = getattr(exc, "detail", None)
    if detail:
        return str(detail)[:1000]
    return f"{type(exc).__name__}: {exc}"[:1000]


def _dump(detail) -> str:
    if detail is None or detail == "":
        return ""
    if isinstance(detail, str):
        return detail[:2000]
    try:
        return json.dumps(detail, ensure_ascii=False, default=str)[:2000]
    except Exception:  # noqa: BLE001
        return str(detail)[:2000]


# ---------------- 落库（独立连接；抢不到锁就排队，绝不静默丢记录） ----------------
#
# 为什么不能只是「开个连接写进去」：路由在抛错时，业务连接常常已经因为一次失败的
# INSERT/UPDATE 而留下未提交的写事务（sqlite3 不会自动回滚），它持有的写锁会让审计连接
# 一直等到 busy_timeout 超时。结果是「操作失败了」这条最关键的记录被丢掉 —— 恰恰是审计
# 最想留下的那一半。
#
# 因此分两步：
#   1. 审计连接把 busy_timeout 压到几百毫秒，快速试一次。抢到锁就直接落库（绝大多数情况，
#      成功路径的审计都走这里）。
#   2. 抢不到就进待写队列。请求收尾时业务连接已关闭、写锁已释放，``drain_deferred`` 再补写。
#
# 队列在进程内存里：被强杀会丢，但它是「写锁竞争」下的兜底，不是常规路径。

# 审计连接最多等锁多久：够用来和短暂的并发写错开，又不至于让一次报错卡住十几秒。
AUDIT_BUSY_MS = 300
# 队列上限：正常路径下它是空的；真堆到这个量只可能是数据库长期写不进去。
DEFERRED_LIMIT = 1000

_DEFERRED: list = []
_DEFERRED_LOCK = threading.Lock()

_CREATORS = {
    "operation": R.AuditLogRepo.create,
    "invocation": R.AgentInvocationRepo.create,
}


def _is_locked(exc) -> bool:
    """是否是「抢不到写锁」这类错误 —— 只有这种才值得排队重试。"""
    return isinstance(exc, sqlite3.Error) and "locked" in str(exc).lower()


def _defer(kind: str, row: dict) -> None:
    with _DEFERRED_LOCK:
        if len(_DEFERRED) >= DEFERRED_LIMIT:
            # 队列满了说明有别的问题（例如磁盘满、库永久锁死）。丢最旧的一条，
            # 保证最新的记录进得来 —— 但一定要出声，不能悄悄丢。
            _DEFERRED.pop(0)
            print("[warn] 审计待写队列已满，丢弃最旧一条记录", flush=True)
        _DEFERRED.append((kind, row))


def pending_count() -> int:
    """还有多少条记录在排队等落库。"""
    with _DEFERRED_LOCK:
        return len(_DEFERRED)


def _insert(kind: str, row: dict) -> None:
    """把一条记录写进库；抢不到锁会抛出带 'locked' 的 OperationalError。"""
    conn = get_conn()
    try:
        # get_conn 默认等 15s；审计宁可快速失败转排队，也不在这里干等。
        conn.execute(f"PRAGMA busy_timeout = {AUDIT_BUSY_MS}")
        _CREATORS[kind](conn, row)
        conn.commit()
    finally:
        conn.close()


def _persist(kind: str, row: dict) -> bool:
    """尝试立刻落库；抢不到写锁就转待写队列。返回是否已经写进库。"""
    try:
        _insert(kind, row)
        return True
    except Exception as e:  # noqa: BLE001 - 审计是旁路，永不打断业务
        if _is_locked(e):
            _defer(kind, row)
            return False
        print(f"[warn] 审计留痕失败: {type(e).__name__}: {e}", flush=True)
        return False


def drain_deferred(limit: int = 50) -> int:
    """补写排队中的记录，返回成功写入的条数。

    由 :meth:`RequestMiddleware.__call__` 在请求收尾时调用 —— 那时业务连接已经关闭，
    它持有的写锁随之释放。仍然抢不到锁就原样留着，下一次请求再试：宁可晚一点写进去，
    也不能把记录弄丢。
    """
    # 先把这一批整段取走，再逐条处理：处理期间不加锁，别的请求也能同时补写自己那批，
    # 不会出现「两条并发补写各弹一次队首、结果漏掉一条」。
    with _DEFERRED_LOCK:
        batch = _DEFERRED[:limit]
        del _DEFERRED[:len(batch)]

    written = 0
    keep_from = None
    for i, (kind, row) in enumerate(batch):
        try:
            _insert(kind, row)
            written += 1
        except Exception as e:  # noqa: BLE001
            if _is_locked(e):
                keep_from = i  # 还锁着：这一条起原封不动留到下次
                break
            # 非锁类错误：这条记录本身有问题，丢掉它，别把整条队列永远卡住
            print(f"[warn] 审计补写失败（丢弃该条）: {type(e).__name__}: {e}", flush=True)
    if keep_from is not None:
        with _DEFERRED_LOCK:
            _DEFERRED[:0] = batch[keep_from:]
    return written


async def adrain_deferred() -> int:
    """drain_deferred 的异步包装：放线程池，别让补写的同步 IO 卡住事件循环。"""
    try:
        return await asyncio.to_thread(drain_deferred)
    except Exception as e:  # noqa: BLE001
        print(f"[warn] 审计补写失败: {type(e).__name__}: {e}", flush=True)
        return 0


# ---------------- 并入实时日志总线 ----------------
#
# 「实时日志」页想看的不只是 agent 输出，还有「谁在什么时候动了这个项目」。操作日志本来
# 就是唯一的收口（所有改状态的动作都必须走 record_operation），因此在这里顺带把同一条
# 记录推进 logbus，埋点不必散落到二十多个路由里。
#
# 归属反查：多数 audit.log 调用只给了 target_type/target_id（如 requirement.delete 只给
# 需求 id），而日志页是按项目过滤的。这里按目标对象反查一次项目 id —— 反查失败（目标已
# 被删除、库不可用）就归到平台级，绝不因此丢掉这条日志；也**不**去改写 audit_logs 里的
# project_id，保持审计表原有语义不变。

_TARGET_PROJECT_SQL = {
    "project": "SELECT id FROM projects WHERE id=?",
    "requirement": "SELECT project_id FROM requirements WHERE id=?",
    "session": "SELECT project_id FROM sessions WHERE id=?",
    "changeset": "SELECT project_id FROM change_sets WHERE id=?",
}

_ACTOR_LABEL = {"admin": "管理员", "token": "令牌", "anonymous": "匿名"}


def _project_of(row: dict) -> int | None:
    """把一条操作日志归到项目上；无法归属时返回 None（平台级）。"""
    if row.get("project_id"):
        return row["project_id"]
    tid = row.get("target_id")
    if tid is None:
        return None
    sql = _TARGET_PROJECT_SQL.get(row.get("target_type") or "")
    if not sql:
        return None
    try:
        conn = get_conn()
        try:
            r = conn.execute(sql, (tid,)).fetchone()
            return r[0] if r and r[0] is not None else None
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 归属查不出来不影响留痕
        return None


def _actor_brief(row: dict) -> str:
    kind = row.get("actor_type") or "anonymous"
    who = row.get("actor") or ""
    if kind == "admin":
        return "管理员"
    if kind == "token":
        return f"令牌 {who}".strip()
    return "匿名访问"


def _emit_bus(row: dict) -> None:
    """把一条操作日志推进实时日志总线。旁路，失败只告警。"""
    try:
        action = row.get("action") or "action"
        name = row.get("target_name") or ""
        failed = row.get("status") == "failure"
        text = f"{action}{f' · {name}' if name else ''} · {_actor_brief(row)}"
        if failed:
            text += f" —— 失败：{row.get('error') or '未提供原因'}"
        LOG.emit(_project_of(row), text,
                 level="error" if failed else "info", source="audit",
                 meta={"action": action, "status": row.get("status") or "success",
                       "target_type": row.get("target_type") or "",
                       "actor_type": row.get("actor_type") or ""})
    except Exception as e:  # noqa: BLE001
        print(f"[warn] 实时日志写入失败: {type(e).__name__}: {e}", flush=True)


def record_operation(*, action: str, actor: dict | None = None, ip: str = "",
                     category: str = "", status: str = "success",
                     target_type: str = "", target_id: int | None = None,
                     target_name: str = "", project_id: int | None = None,
                     project_name: str = "", detail=None, error: str = "") -> None:
    """记一条操作日志。任何字段缺失都按空处理，不抛异常。"""
    a = actor or {}
    row = {
        "actor_type": a.get("actor_type") or "anonymous",
        "actor": a.get("actor") or "",
        "token_id": a.get("token_id"),
        "ip": ip or "",
        "category": category or (action.split(".", 1)[0] if "." in action else "other"),
        "action": action,
        "status": status if status in AUDIT_STATUSES else "success",
        "target_type": target_type or "",
        "target_id": target_id,
        "target_name": (target_name or "")[:200],
        "project_id": project_id,
        "project_name": (project_name or "")[:200],
        "detail": _dump(detail),
        "error": (error or "")[:1000],
    }
    _persist("operation", row)
    _emit_bus(row)


def record_invocation(*, source: str, agent=None, prompt: str = "", response: str = "",
                      error: str = "", status: str = "", elapsed_ms: int = 0,
                      event_count: int = 0, timed_out: bool = False,
                      rate_limited: bool = False, project=None, requirement=None,
                      session_id: int | None = None, actor: dict | None = None,
                      usage: dict | None = None) -> None:
    """记一条 Agent 调用留痕。成功与失败都必须调用它，这是硬性要求。"""
    agent = agent or {}
    project = project or {}
    requirement = requirement or {}
    a = actor or {}
    p_tok, c_tok, t_tok, estimated = tokens_of(prompt, response, usage)
    st = status or ("error" if error else "success")
    row = {
        "source": source if source in INVOCATION_SOURCES else "session",
        "agent_id": agent.get("id"),
        "agent_name": (agent.get("name") or "")[:200],
        "agent_type": (agent.get("type") or "")[:50],
        "model": model_of(agent),
        "project_id": project.get("id"),
        "project_name": (project.get("name") or "")[:200],
        "requirement_id": requirement.get("id"),
        "requirement_title": (requirement.get("title") or "")[:200],
        "session_id": session_id,
        "actor_type": a.get("actor_type") or "",
        "actor": a.get("actor") or "",
        "status": st if st in INVOCATION_STATUSES else "success",
        "error": (error or "")[:2000],
        "timed_out": 1 if timed_out else 0,
        "rate_limited": 1 if rate_limited else 0,
        "prompt": (prompt or "")[:PROMPT_LIMIT],
        "response": (response or "")[:RESPONSE_LIMIT],
        "event_count": int(event_count or 0),
        "elapsed_ms": int(elapsed_ms or 0),
        "prompt_tokens": p_tok,
        "completion_tokens": c_tok,
        "total_tokens": t_tok,
        "tokens_estimated": estimated,
    }
    _persist("invocation", row)


async def arecord_invocation(**kw) -> None:
    """record_invocation 的异步包装：写盘放到线程池，不阻塞事件循环。

    会话运行与一键测试都跑在事件循环里，一次同步 INSERT 虽小，但每次调用都卡一下
    事件循环会拖慢同进程的其他 SSE 连接。
    """
    try:
        await asyncio.to_thread(lambda: record_invocation(**kw))
    except Exception as e:  # noqa: BLE001
        print(f"[warn] 审计留痕失败: {type(e).__name__}: {e}", flush=True)


# ---------------- 请求上下文：解析「是谁在操作」 ----------------
#
# 身份从哪来？一个纯 ASGI 中间件在请求进入时把「原始凭证 + 来源 IP」挂到上下文变量上
# （见 RequestMiddleware），路由里直接 ``audit.log(...)`` 即可，不必给每个受审计的路由
# 多加一个注入参数。解析只读 query string，真正的库查询推迟到真要写日志那一刻
# （``RequestIdentity.resolve``），所以绝大多数请求不会为审计多付一次查询。
#
# 为什么不写成 FastAPI 的 Depends：二十多个路由都要挂它，签名噪音大；而且单测习惯直接调
# 路由函数，Depends 根本不会被注入 —— 那里拿到的是 Depends 对象而不是上下文，一调就炸。

_REQUEST: contextvars.ContextVar = contextvars.ContextVar("cap_audit_request", default=None)


def identify(db, token: str | None, admin: str | None) -> dict:
    """解析操作者身份。

    管理员口令有效时记为 admin（它天然看得见全部项目）；否则按访问令牌记为 token，
    并把令牌脱敏后入日志。两者都不成立时记 anonymous —— 匿名也会留下痕迹，
    这恰恰是审计最想看到的那一类。
    """
    from .config import CONFIG
    if CONFIG.admin_token and admin and admin == CONFIG.admin_token:
        return {"actor_type": "admin", "actor": "admin", "token_id": None}
    if token and db is not None:
        row = R.TokenRepo.resolve(db, token)
        if row:
            return {"actor_type": "token", "actor": mask_token(row.get("token")),
                    "token_id": row.get("id")}
    if token:
        # 拿不到库时仍如实记下「这是一个令牌请求」，只是没有 token_id 可关联
        return {"actor_type": "token", "actor": mask_token(token), "token_id": None}
    return {"actor_type": "anonymous", "actor": "", "token_id": None}


def _parse_scope(scope) -> tuple[str | None, str | None, str]:
    """从 ASGI scope 里取 ``?token=`` / ``?admin=`` 与调用方 IP。"""
    params = urllib.parse.parse_qs((scope.get("query_string") or b"").decode("latin-1"))
    token = (params.get("token") or [None])[0]
    admin = (params.get("admin") or [None])[0]
    ip = ""
    for name, value in (scope.get("headers") or []):
        if name.lower() == b"x-forwarded-for":
            ip = value.decode("latin-1").split(",")[0].strip()
            break
    if not ip:
        client = scope.get("client") or ()
        ip = client[0] if client else ""
    return token, admin, ip[:60]


class RequestIdentity:
    """一次请求的身份快照（原始凭证，未解析）。"""

    def __init__(self, token: str | None = None, admin: str | None = None, ip: str = ""):
        self.token = token
        self.admin = admin
        self.ip = ip

    def resolve(self) -> dict:
        """查库解析出 actor（管理员不查库；令牌按 token 查一次）。"""
        conn = get_conn()
        try:
            return identify(conn, self.token, self.admin)
        finally:
            conn.close()


class RequestMiddleware:
    """纯 ASGI 中间件：只做一件事 —— 把请求身份放进上下文变量。

    刻意不用 ``@app.middleware("http")``（BaseHTTPMiddleware）：它会把请求包进额外的任务
    与内存流，本应用的 SSE 长连接（工作台 agent 事件流）不值得为此冒险。纯 ASGI 中间件在
    同一个任务里 ``await`` 下游，上下文变量必然可见 —— 包括同步路由所在的 AnyIO 线程
    （``run_in_threadpool`` 会拷贝当前上下文）。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        reset = _REQUEST.set(RequestIdentity(*_parse_scope(scope)))
        try:
            await self.app(scope, receive, send)
        finally:
            _REQUEST.reset(reset)
            # 请求收尾：业务连接已关闭、写锁已释放，此时才补得进之前被锁挡住的那几条
            # 失败留痕。放在这里而不是路由里，是因为它必须晚于依赖的 finally。
            if pending_count():
                await adrain_deferred()


def actor() -> dict:
    """当前请求的操作者身份。没有绑定时记匿名 —— 匿名也要留痕，那正是审计想看的。"""
    ident = _REQUEST.get()
    if ident is None:
        return {"actor_type": "anonymous", "actor": "", "token_id": None}
    return ident.resolve()


def current_ip() -> str:
    ident = _REQUEST.get()
    return ident.ip if ident else ""


def log(action: str, **kw) -> None:
    """写一条操作日志：``audit.log("project.delete", target_type="project", target_id=pid)``。"""
    ident = _REQUEST.get()
    record_operation(action=action, actor=actor(), ip=ident.ip if ident else "", **kw)


class guard:
    """上下文管理器：块内抛异常时记一条失败日志并继续抛出。

    成功路径由调用方自己写 ``audit.log(...)``（那里才拿得到新建对象的 id / 名称），
    这里只负责把失败补上 —— 审计如果只记成功，等于把最该记的那一半弄丢了。

    用法::

        with audit.guard("project.delete", target_type="project", target_id=pid):
            R.ProjectRepo.delete(db, pid)
        audit.log("project.delete", target_type="project", target_id=pid)
    """

    def __init__(self, action: str, **kw):
        self.action = action
        self.kw = kw

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is not None:
            log(self.action, status="failure", error=_err_text(exc), **self.kw)
        return False
