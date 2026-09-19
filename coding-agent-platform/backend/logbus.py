"""项目实时日志总线：进程内环形缓冲 + 序列号增量读取，供项目「实时日志」页观测。

定位与边界（改动前先读）：

- **它是「运行诊断流」，不是审计。** 审计（audit_logs / agent_invocations）是持久化的
  追责台账，一条都不能丢；日志总线是易失的观测数据，只保留最近 MAX_RECORDS 条，进程重启
  即清空。两者互补但不可互相替代 —— 尤其不要为了「日志也要留存」把这里改成写库：
  每次 agent 输出都打一次同步 INSERT，会把工作台的 SSE 拖垮。
- **写入永不抛异常。** 埋点散落在业务主路径与子进程输出读取协程里，日志是旁路，
  不能因为日志写不进去就让一次 agent 运行失败（与 audit 同样的硬约束）。
- **每条记录按项目归属。** project_id 为 None 表示平台级（如未绑定项目的 Agent 一键测试）。
  项目页默认只看本项目的记录，可显式打开「包含平台日志」。

并发模型：emit 可能来自事件循环线程、AnyIO 线程池与子进程读取协程。缓冲与序列号统一由
``threading.Lock`` 保护；读取做法是「加锁切片成快照」，读者之间互不影响。刻意不做
per-subscriber 队列：轮询快照天然线程安全，实现与排查成本都低得多，而日志量本就不高。

归属传递：适配器只拿到 ``(agent, message, project_path)``，拿不到项目 id。用 contextvar
把归属从调用方传给适配器的输出埋点，免去给 ``CodingAgentProvider.invoke`` 加参数
——那会波及所有替身适配器与冒烟脚本。见 ``bind`` / ``emit_current``。
"""
import collections
import contextlib
import contextvars
import datetime
import itertools
import threading

# 级别由轻到重；未知级别一律降级为 info，保证前端配色表永远命中。
LEVELS = ("debug", "info", "warn", "error")
_LEVEL_ALIASES = {"warning": "warn", "warn": "warn", "err": "error", "fatal": "error",
                  "critical": "error", "trace": "debug", "notice": "info"}

# 来源取值建议（前端筛选器据此渲染）。刻意不强制校验：写入未知来源时原样保留，
# 前端默认「全部来源」仍然看得见，不会因为写错一个词就静默丢失一整类日志。
SOURCES = ("session", "agent", "probe", "files", "audit", "system")

MAX_RECORDS = 2000      # 环形缓冲上限
MAX_TEXT = 8000         # 单条记录正文上限（超出按「头 + 尾」截断，保留结论）
MAX_LINES_PER_EMIT = 200  # 一次 emit_lines 最多产出多少行，防止一次巨量输出打爆缓冲
MAX_LINE = 2000         # 单行上限（agent 输出里偶尔有压缩成一行的超长 JSON）

_LOCK = threading.Lock()
_BUF: collections.deque = collections.deque(maxlen=MAX_RECORDS)
_SEQ = itertools.count(1)

_SCOPE: contextvars.ContextVar = contextvars.ContextVar("cap_log_scope", default=None)

LEVEL_COLORS = {"debug": "default", "info": "blue", "warn": "orange", "error": "red"}


# ---------------- 纯函数（可单测，不共享状态） ----------------

def normalize_level(level) -> str:
    """把各家写法归一到 LEVELS 之一；无法识别时按 info 处理。"""
    lv = str(level or "").strip().lower()
    lv = _LEVEL_ALIASES.get(lv, lv)
    return lv if lv in LEVELS else "info"


def normalize_source(source) -> str:
    """来源归一：去空白、转小写；空值落到 system。未知来源原样保留（见 SOURCES 注释）。"""
    return str(source or "").strip().lower() or "system"


def split_lines(text, limit: int = MAX_LINES_PER_EMIT) -> list:
    """把一段多行输出切成日志行：统一换行符、去掉空行、单行限长、整体限行数。

    超出行数上限时保留**前** limit 行并追加一行省略提示：日志按阅读顺序展开，
    先看到的先成立；被丢弃的总量会明确写出来，不做无声截断。
    """
    body = str(text if text is not None else "")
    lines = [ln.rstrip()[:MAX_LINE] for ln in
             body.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    keep = [ln for ln in lines if ln.strip()]
    if len(keep) > limit > 0:
        omitted = len(keep) - limit
        keep = keep[:limit] + [f"… 本次输出还有 {omitted} 行未记录（超出单次上限）…"]
    return keep


def clip_text(text, limit: int = MAX_TEXT) -> str:
    """超长正文按「头 + 省略说明 + 尾」截断。

    agent 输出常常是「开头铺垫 + 结尾结论」，只留头部会把最该看的部分丢掉。
    """
    body = str(text if text is not None else "")
    if limit <= 0 or len(body) <= limit:
        return body
    head = int(limit * 0.6)
    tail = limit - head
    return f"{body[:head]}\n…（中间省略 {len(body) - limit} 字符）…\n{body[-tail:]}"


def _now() -> str:
    n = datetime.datetime.now()
    return n.strftime("%Y-%m-%d %H:%M:%S.") + f"{n.microsecond // 1000:03d}"


# ---------------- 写入 ----------------

def emit(project_id=None, text="", level="info", source="system", meta=None):
    """追加一条日志。返回记录（dict），任何异常都吞掉并返回 None。

    这是唯一写入口；调用方不需要、也不应该处理它的异常。
    """
    try:
        try:
            pid = None if project_id is None else int(project_id)
        except (TypeError, ValueError):
            pid = None
        with _LOCK:
            rec = {
                "seq": next(_SEQ),
                "ts": _now(),
                "project_id": pid,
                "level": normalize_level(level),
                "source": normalize_source(source),
                "text": clip_text(text),
                "meta": meta or None,
            }
            _BUF.append(rec)
        return rec
    except Exception:  # noqa: BLE001 - 日志是旁路，绝不打断业务
        return None


def emit_lines(project_id=None, text="", level="info", source="system", meta=None) -> int:
    """把一段多行文本逐行写成日志，返回实际写入条数。"""
    lines = split_lines(text)
    for ln in lines:
        emit(project_id, ln, level=level, source=source, meta=meta)
    return len(lines)


def set_scope(project_id=None, session_id=None, requirement_id=None):
    """设置当前执行上下文（项目/会话/需求），返回还原用的 token。"""
    return _SCOPE.set({"project_id": project_id, "session_id": session_id,
                       "requirement_id": requirement_id})


def reset_scope(token) -> None:
    try:
        _SCOPE.reset(token)
    except Exception:  # noqa: BLE001 - 上下文错配不该打断业务
        pass


@contextlib.contextmanager
def bind(project_id=None, session_id=None, requirement_id=None):
    """``with bind(project_id=pid):`` —— 块内的 ``emit_current`` 自动带上归属。"""
    token = set_scope(project_id, session_id, requirement_id)
    try:
        yield
    finally:
        reset_scope(token)


def scope() -> dict:
    return _SCOPE.get() or {}


def emit_current(text, level="info", source="system", meta=None):
    """按当前上下文写一条日志（给拿不到项目 id 的适配器用）。"""
    sc = scope()
    merged = {"session_id": sc.get("session_id"), "requirement_id": sc.get("requirement_id")}
    if meta:
        merged.update(meta)
    merged = {k: v for k, v in merged.items() if v is not None}
    return emit(sc.get("project_id"), text, level=level, source=source,
                meta=merged or None)


def emit_lines_current(text, level="info", source="system", meta=None) -> int:
    """按当前上下文把一段多行文本逐行写成日志，返回实际写入条数。"""
    lines = split_lines(text)
    for ln in lines:
        emit_current(ln, level=level, source=source, meta=meta)
    return len(lines)


# ---------------- 读取 ----------------

def snapshot(project_id=None, after_seq=0, limit: int = 500, levels=None, sources=None,
             include_global: bool = False) -> dict:
    """按 seq 增量读取日志快照。

    - ``project_id`` 为 None 表示不按项目过滤（取全部）；给定项目时默认只取该项目，
      ``include_global=True`` 时把平台级（project_id 为 None）记录一并带上。
    - ``after_seq`` 之后（不含）的记录才会返回，用于断线续传与增量轮询。
    - ``levels`` / ``sources`` 为空表示不过滤。
    - 命中的条数超过 ``limit`` 时取**最新** limit 条并置 ``truncated``，
      由调用方决定是提示「产生太快」还是重试更大的 limit。

    ``dropped`` 表示客户端请求的位置已经早于缓冲最老的一条（中间有记录被滚出），
    ``buffered`` / ``capacity`` 供界面提示缓冲水位。
    """
    try:
        after = max(0, int(after_seq or 0))
    except (TypeError, ValueError):
        after = 0
    try:
        limit = int(limit or 500)
    except (TypeError, ValueError):
        limit = 500
    level_set = {normalize_level(x) for x in levels} if levels else None
    source_set = {normalize_source(x) for x in sources} if sources else None

    with _LOCK:
        oldest = _BUF[0]["seq"] if _BUF else 0
        buffered = len(_BUF)
        hits = []
        for r in _BUF:
            if r["seq"] <= after:
                continue
            if project_id is not None:
                if r["project_id"] != project_id and not (
                        include_global and r["project_id"] is None):
                    continue
            if level_set is not None and r["level"] not in level_set:
                continue
            if source_set is not None and r["source"] not in source_set:
                continue
            hits.append(r)

    truncated = limit > 0 and len(hits) > limit
    if truncated:
        hits = hits[-limit:]
    return {
        "records": hits,
        "last_seq": hits[-1]["seq"] if hits else after,
        "dropped": bool(oldest) and oldest > after + 1,
        "truncated": truncated,
        "buffered": buffered,
        "capacity": MAX_RECORDS,
    }


def stats() -> dict:
    with _LOCK:
        return {
            "buffered": len(_BUF),
            "capacity": MAX_RECORDS,
            "oldest_seq": _BUF[0]["seq"] if _BUF else 0,
            "newest_seq": _BUF[-1]["seq"] if _BUF else 0,
        }


def reset() -> None:
    """清空缓冲并重置序列号。仅单测与冒烟使用，运行时没有清空入口。"""
    global _SEQ
    with _LOCK:
        _BUF.clear()
        _SEQ = itertools.count(1)
