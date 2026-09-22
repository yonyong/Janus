"""会话/消息服务：创建会话、调用 agent provider、落库、产出事件流。

幂等与断线续传设计：
- 同一 (session_id, message) 对应唯一一次 agent 运行（run）。
- run 在后台 asyncio 任务中执行，与 SSE 连接生命周期解耦：客户端断线不会杀死
  正在运行的 agent，重连（同一 message）会订阅同一 run 的实时流，不会重复调用
  agent（避免重复改盘 / 重复落库）。
- run 完成后由 DB 回放（replay），内存中的 run 状态在最后一个订阅者离开后清理，
  不会无限增长。

单飞约束（跨机器同会话）：
- 同一 session 同一时刻只允许一个未完成的 run。
- 不同 message 在已有 run 进行中时拒绝新建（SessionBusyError），避免双端同时提问
  交错落库 / 互相改盘，导致最终对话展示错乱。
- 同一 message 重连仍走 live / replay 幂等路径，不受单飞影响。
"""
import asyncio
import datetime
import json
import subprocess
import time
from . import audit
from . import logbus as LOG
from . import repositories as R
from . import diff as D
from . import docs as WD
from . import snapshots as SN
from .db import get_conn
from .agent_runtime import AgentRegistry


# ---------------- 运行注册表（进程内，仅保留进行中 + 有订阅者的 run） ----------------
_RUNS: dict = {}          # run_id -> _RunState
_RUN_KEY: dict = {}       # (session_id, message) -> run_id
_TICK = object()          # 唤醒订阅者的空信号


class SessionBusyError(RuntimeError):
    """会话已有进行中的 run，拒绝用另一条消息再开新 run。

    携带 active_run_id / active_message，供 SSE 层回给前端做提示或续传挂接。
    """

    def __init__(self, active_run_id, active_message):
        self.active_run_id = active_run_id
        self.active_message = active_message
        brief = (active_message or "").strip().replace("\n", " ")[:80]
        super().__init__(
            f"会话正在运行中（{brief or '进行中'}），请等待完成或先中止后再提问"
        )


class _RunState:
    def __init__(self, run_id, session_id, message, actor=None):
        self.run_id = run_id
        self.session_id = session_id
        self.message = message
        self.actor = actor    # 触发本次运行的身份，用于 Agent 调用留痕
        self.buffer = []          # 已产出事件（dict）
        self.subscribers = []     # asyncio.Queue 列表
        self.done = False
        # 真中止的凭据：task 是后台运行任务本身的句柄（cancel 它才会把 CancelledError
        # 注进 provider.invoke 的 await 点，适配器据此连进程树杀掉 CLI 子进程）；
        # abort_requested 只做展示用途，真正的终止以 task.cancel() 为准。
        self.task: asyncio.Task | None = None
        self.abort_requested = False
        # 运行收尾元信息：stream_run 的 done 事件带给前端，对话气泡底部展示
        self.elapsed_ms: int | None = None
        self.usage: dict | None = None


def _notify(state):
    for q in list(state.subscribers):
        try:
            q.put_nowait(_TICK)
        except Exception:
            pass


def _publish(state, item):
    state.buffer.append(item)
    _notify(state)


def _maybe_cleanup(run_id, state):
    if state.done and not state.subscribers:
        _RUNS.pop(run_id, None)
        _RUN_KEY.pop((state.session_id, state.message), None)


class SessionService:
    @staticmethod
    def create(conn, requirement_id, agent_id=None, project_id=None):
        req = R.RequirementRepo.get(conn, requirement_id)
        if req is None:
            raise ValueError("需求不存在")
        if project_id is None:
            project_id = req["project_id"]
        if agent_id is None:
            # 默认取排位最前的可用 Agent：列表顺序即优先级，日限额用满的顺位跳过
            usage = R.AgentRepo.usage_map(conn)
            for a in R.AgentRepo.list(conn):
                if R.AgentRepo.is_available(a, usage.get(a["id"], 0)):
                    agent_id = a["id"]
                    break
            if agent_id is None:
                raise RuntimeError(
                    "没有可用的 coding agent（可能今日 Token 限额已用完）；"
                    "请先在「Agent 管理」调整限额或添加一个 agent"
                )
        else:
            agent = R.AgentRepo.get(conn, agent_id)
            if agent is None:
                raise ValueError("Agent 不存在")
            usage = R.AgentRepo.usage_map(conn)
            if not R.AgentRepo.is_available(agent, usage.get(agent["id"], 0)):
                raise RuntimeError(
                    f"Agent「{agent['name']}」今日 Token 限额已用完，请换一个或调整限额"
                )
        proj = R.ProjectRepo.get(conn, project_id)
        branch = None
        try:
            branch = f"agent/{requirement_id}-{datetime.datetime.now().strftime('%Y%m%d%H%M%S%f')}"
            subprocess.run(["git", "-C", proj["disk_path"], "checkout", "-b", branch],
                           capture_output=True, text=True, check=True)
        except Exception:
            branch = None  # 非 git 仓库时跳过分支隔离
        return R.SessionRepo.create(conn, requirement_id, agent_id, project_id, branch)

    @staticmethod
    def set_agent(conn, session_id, agent_id):
        """切换会话当前使用的 coding agent。

        - agent 必须存在且当日限额可用；
        - 不允许在有进行中的 run 时切换（避免半截流式输出绑到另一个 Agent）；
        - 换 Agent 会清空 cli_session_id，后续消息按新 Agent 重新起聊。
        """
        sess = R.SessionRepo.get(conn, session_id)
        if sess is None:
            raise ValueError("会话不存在")
        # 有进行中的 run 时禁止切换：_RUN_KEY 按 (session_id, message) 索引，
        # 这里扫一遍当前会话是否仍有未 done 的 run。
        for state in list(_RUNS.values()):
            if state.session_id == session_id and not state.done:
                raise RuntimeError("Agent 正在运行，请先等待完成或中止后再切换")
        agent = R.AgentRepo.get(conn, agent_id)
        if agent is None:
            raise ValueError("Agent 不存在")
        usage = R.AgentRepo.usage_map(conn)
        if not R.AgentRepo.is_available(agent, usage.get(agent["id"], 0)):
            raise RuntimeError(
                f"Agent「{agent['name']}」今日 Token 限额已用完，请换一个或调整限额"
            )
        if sess.get("agent_id") == agent_id:
            return sess
        return R.SessionRepo.set_agent(conn, session_id, agent_id)

    @staticmethod
    def resolve_run(conn, session_id, message, actor=None):
        """返回 (mode, run_id)。mode ∈ {'replay','live','new'}。

        - replay: 该消息已有完整 agent 输出，调用方应从 DB 回放（断线后重连已完成运行）。
        - live:   已有正在进行的 run，调用方应订阅其实时流（断线续传，不重复调用 agent）。
        - new:    尚无输出，已创建新 run 并在后台执行。

        若该会话已有另一条消息的进行中 run，抛出 SessionBusyError（单飞：一会话同时
        只跑一个 agent），调用方应拒绝本次提问而不是静默开第二条并行流。

        actor 是触发者的身份（见 audit.identify），只用于 Agent 调用留痕。
        """
        key = (session_id, message)
        # 日志归属：会话 → 项目。查不到（会话已被删）时归到平台级，日志照样留痕。
        sess_row = R.SessionRepo.get(conn, session_id)
        pid = sess_row["project_id"] if sess_row else None
        brief = message.strip().replace("\n", " ")[:120]

        existing = _RUN_KEY.get(key)
        if existing is not None and existing in _RUNS and not _RUNS[existing].done:
            LOG.emit(pid, f"复用进行中的运行（会话 #{session_id}）：{brief}", level="debug",
                     source="session", meta={"session_id": session_id, "run_id": existing})
            return "live", existing

        # 会话单飞：已有其它消息的进行中 run 时禁止新建（跨机器同 URL 并发提问的权威闸门）。
        # 必须放在 replay / new 之前：否则另一端的不同文案会并行落库并交错改盘。
        active_id, active_msg = SessionService.active_run_for_session(session_id)
        if active_id is not None:
            LOG.emit(
                pid,
                f"拒绝并发提问（会话 #{session_id} 已有运行 {active_id}）",
                level="warn",
                source="session",
                meta={
                    "session_id": session_id,
                    "run_id": active_id,
                    "blocked_message": brief,
                },
            )
            raise SessionBusyError(active_id, active_msg)

        # DB 侧判定是否已存在完成态运行
        msgs = R.MessageRepo.list_by_session(conn, session_id)
        last_user_idx = max((i for i, m in enumerate(msgs) if m["role"] == "user"), default=-1)
        completed = (
            last_user_idx >= 0
            and msgs[last_user_idx]["content"] == message
            and any(m["role"] == "agent" for m in msgs[last_user_idx + 1:])
        )
        if completed:
            LOG.emit(pid, f"该消息已有完整输出，回放历史记录（会话 #{session_id}）",
                     level="debug", source="session", meta={"session_id": session_id})
            return "replay", None

        # 新建 run：落库用户消息（每轮一次），后台执行 agent
        run_id = f"run-{session_id}-{datetime.datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        R.MessageRepo.create(conn, session_id, "user", "message", message, 0)
        state = _RunState(run_id, session_id, message, actor)
        _RUNS[run_id] = state
        _RUN_KEY[key] = run_id
        LOG.emit(pid, f"收到指令，启动 Agent 运行（会话 #{session_id}）：{brief}",
                 level="info", source="session",
                 meta={"session_id": session_id, "run_id": run_id})
        state.task = asyncio.create_task(_run_agent(run_id, session_id, message))

        def _finalize_dead_task(t, _st=state):
            # 兜底：任务在执行任何一步之前就被 cancel（例如发送后同一事件循环轮次内
            # 立即中止）时，协程体完全不运行、finally 不执行，done 永远不会置位，
            # 订阅者会永远等不到收尾。这里在任务终结时补上收尾（正常路径下
            # _run_agent 的 finally 已置 done，本回调是无操作）。
            if not _st.done:
                _st.done = True
                _notify(_st)
                _maybe_cleanup(_st.run_id, _st)

        state.task.add_done_callback(_finalize_dead_task)
        return "new", run_id

    @staticmethod
    def abort_run(session_id):
        """真中止：取消该会话进行中的 run 任务，返回 (run_id, message)；没有则 (None, None)。

        为什么 cancel 就是真中止：task 被取消时 CancelledError 会注入 provider.invoke
        正在挂起的 await 点（正在读子进程管道），CLI 适配器在该异常的处理分支里
        ``taskkill /T`` 连整棵子进程树一起杀（见 adapters/codebuddy.py::_terminate），
        并等待其退出 —— 后台不会再有 AI 进程继续烧 token / 改盘。
        必须在事件循环内调用（路由为 async def），跨线程 cancel 不安全。
        """
        run_id, message = SessionService.active_run_for_session(session_id)
        if run_id is None:
            return None, None
        state = _RUNS.get(run_id)
        if state is None or state.task is None or state.task.done():
            return None, None
        state.abort_requested = True
        state.task.cancel()
        return run_id, message

    @staticmethod
    def active_run_for_session(session_id):
        """返回该会话仍在进行的 run 的 (run_id, message)；没有则 (None, None)。

        前端刷新/断线后用它在「会话」维度（而不是靠记住消息内容）重新发现
        进行中的运行，从而重新订阅 SSE —— run 与连接解耦，重订会从事件 0 完整回放。
        """
        for run_id, st in _RUNS.items():
            if st.session_id == session_id and not st.done:
                return run_id, st.message
        return None, None

    @staticmethod
    async def stream_run(run_id, start_index=0):
        """订阅 run 的事件流：先回放缓冲区，再实时推送，结束后发 done。

        run_id 不存在（极少见的竞态）时直接 done，调用方应回退到 DB 回放。
        """
        state = _RUNS.get(run_id)
        if state is None:
            yield {"type": "done"}
            return
        i = start_index
        q = asyncio.Queue()
        state.subscribers.append(q)
        try:
            while True:
                while i < len(state.buffer):
                    yield state.buffer[i]
                    i += 1
                if state.done:
                    break
                await q.get()
        finally:
            if q in state.subscribers:
                state.subscribers.remove(q)
            _maybe_cleanup(run_id, state)
        done = {"type": "done"}
        if state.elapsed_ms is not None:
            done["elapsed_ms"] = state.elapsed_ms
        if state.usage:
            done["usage"] = state.usage
        yield done


def _diff_summary(diff: str) -> str:
    """把一段 git diff 概括成一句话（文件数 + 增删行数），未知格式则给中性描述。"""
    text = diff or ""
    files = sum(1 for ln in text.splitlines() if ln.startswith("diff --git "))
    added = sum(1 for ln in text.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in text.splitlines() if ln.startswith("-") and not ln.startswith("---"))
    if not files:
        return "工作区已改动"
    return f"工作区已改动 {files} 个文件（+{added} / -{removed} 行）"


def _log_agent_event(pid, session_id, ev, payload):
    """把一个 agent 事件映射成项目日志行。

    ``payload`` 是事件序列化后的整份字典（``{type,pane,text,payload}``），事件自己的
    payload 在它的 ``payload`` 键下 —— 别把两层当成一层（曾经因此漏判，导致同一批
    stderr 在日志里出现两次）。

    message 事件只写一句 debug 摘要，**不落正文**：它的完整内容已经在对话面板里，
    逐字重复进日志只会把真正的运行细节挤下去。一行行的原始输出由适配器负责
    （``source="agent"``，见 adapters/codebuddy.py 的 ``_pump``）。
    """
    meta = {"session_id": session_id}
    inner = (payload or {}).get("payload") or {}
    text = (ev.text or "").strip()
    if ev.type == "error":
        LOG.emit(pid, f"Agent 报错：{text[:600] or '未提供原因'}",
                 level="error", source="session", meta=meta)
    elif ev.type == "edit":
        LOG.emit(pid, _diff_summary((payload or {}).get("diff") or ""),
                 level="info", source="files", meta=meta)
    elif ev.type == "info":
        if inner.get("streamed"):
            # 适配器已经把这段原始输出逐行实时推送过了（见 codebuddy._pump）。
            # 这里再整段记一遍，同一批 stderr 会在日志里出现两次，纯属干扰。
            LOG.emit(pid, f"Agent 标准错误输出 {len(text.splitlines())} 行（已逐行实时记录）",
                     level="debug", source="session", meta=meta)
        else:
            # 其他适配器没有流式输出能力，这里替它们逐行记录，保证内容不丢
            LOG.emit_lines(pid, ev.text or "", level="warn", source="agent", meta=meta)
    elif ev.type == "test":
        LOG.emit(pid, f"测试输出：{text[:400]}", level="info", source="session", meta=meta)
    elif ev.type == "message":
        LOG.emit(pid, f"Agent 输出完成（{len(ev.text or '')} 字符，完整内容见对话面板）",
                 level="debug", source="session", meta=meta)
    else:
        LOG.emit(pid, f"事件 {ev.type}", level="debug", source="session", meta=meta)


async def _run_agent(run_id, session_id, message):
    state = _RUNS.get(run_id)
    if state is None:
        return
    conn = None
    started = time.perf_counter()
    agent = proj = req = sess = None
    pid = None
    texts: list[str] = []
    error = ""
    agent_error = ""
    aborted = False  # 是否被用户主动中止（task.cancel 触发，区别于 agent 自身报错）
    usage = None  # 适配器带回的真实 token 用量（CLI JSON 结果解析所得，见 codebuddy 适配器）
    try:
        conn = get_conn()
        sess = R.SessionRepo.get(conn, session_id)
        if sess is None:
            error = "会话不存在，无法执行"
            _publish(state, {"type": "error", "text": error})
            return
        agent = R.AgentRepo.get(conn, sess["agent_id"])
        proj = R.ProjectRepo.get(conn, sess["project_id"])
        req = R.RequirementRepo.get(conn, sess["requirement_id"])
        pid = sess["project_id"]
        if agent is None or proj is None:
            error = "关联 agent 或项目已不存在，无法执行"
            LOG.emit(pid, error, level="error", source="session",
                     meta={"session_id": session_id})
            _publish(state, {"type": "error", "text": error})
            return
        # 限额兜底：会话建立后 Agent 当日限额才用满的情况在这里拦下（SSE 入口也有一道）
        used = R.AgentRepo.usage_map(conn).get(agent["id"], 0)
        if not R.AgentRepo.is_available(agent, used):
            error = (f"Agent「{agent['name']}」的今日 Token 限额已用完"
                     f"（{R.AgentRepo.quota_text(agent, used)}），暂不可用；"
                     "请在「Agent 管理」调整限额，或将其他可用 Agent 拖到前面")
            LOG.emit(pid, error, level="error", source="session",
                     meta={"session_id": session_id, "agent": agent["name"]})
            _publish(state, {"type": "error", "text": error})
            return
        provider = AgentRegistry.get(agent["type"])
        LOG.emit(pid, f"准备就绪：Agent「{agent['name']}」({agent['type']}) 在 {proj['disk_path']} 执行",
                 level="debug", source="session",
                 meta={"session_id": session_id, "agent": agent["name"], "run_id": run_id})
        # 运行前拍快照：agent 是子进程改盘，只有比对前后快照才知道它到底动了哪些文件。
        # 放进线程执行，避免整仓扫描把事件循环卡住、影响其他会话的 SSE。
        sn_started = time.perf_counter()
        before, before_truncated = await asyncio.to_thread(SN.capture, proj["disk_path"])
        LOG.emit(pid, f"工作区快照完成（{len(before)} 个文件，"
                      f"{int((time.perf_counter() - sn_started) * 1000)}ms）",
                 level="debug", source="files", meta={"session_id": session_id})
        try:
            # 归属挂在上下文里：适配器拿不到项目 id，靠它把子进程原始输出归到本项目
            with LOG.bind(project_id=pid, session_id=session_id,
                          requirement_id=sess["requirement_id"]):
                # 聊天指令是自由输入的，Agent 不知道平台目录规范，会自己猜路径
                # （真实案例：把详细设计写进遗留的 .janus/docs/requirement.md）。
                # 每轮消息前拼上路径约定，聊天 Agent 与快捷指令共享同一套规范。
                prompt = WD.agent_context_brief((req or {}).get("dir_name") or "") + message
                # 续聊：本会话若已记过底层 CLI 外部会话 id，用它 --resume（不拼 prompt 历史）
                resume_id = sess.get("cli_session_id") or None
                async for ev in provider.invoke(agent, prompt, proj["disk_path"],
                                                resume_id=resume_id):
                    # session 事件：底层 CLI 首轮返回的外部会话 id，落库供后续轮次续聊。
                    # 不落对话、不推前端、不进审计（纯内部状态）。
                    if ev.type == "session":
                        ext = (ev.payload or {}).get("cli_session_id")
                        if ext:
                            try:
                                R.SessionRepo.set_cli_session_id(conn, session_id, ext)
                            except Exception as e:  # noqa: BLE001 - 落库失败不该中断运行
                                LOG.emit(pid, f"记录 CLI 会话 id 失败：{e}", level="warn",
                                         source="session", meta={"session_id": session_id})
                        continue
                    payload = json.loads(ev.to_json())
                    if ev.type == "edit" and proj is not None:
                        payload["diff"] = D.compute(proj["disk_path"])
                    inner = (payload or {}).get("payload") or {}
                    if ev.type == "delta" or inner.get("transient"):
                        # 流式增量 / 瞬态过程（中间轮次正文、调用工具提示）：只往前端推，
                        # 不落库、不进审计正文 —— 对话主线与留痕只保留最终答复。
                        _publish(state, payload)
                        continue
                    if ev.text:
                        texts.append(ev.text)
                    u = (ev.payload or {}).get("usage")
                    if isinstance(u, dict) and u:
                        usage = u
                    if ev.type == "error" and not agent_error:
                        agent_error = (ev.text or "").strip() or "Agent 返回了 error 事件"
                    R.MessageRepo.create(
                        conn, session_id, "agent", ev.pane,
                        ev.text or "", 1 if ev.type == "edit" else 0,
                    )
                    _log_agent_event(pid, session_id, ev, payload)
                    _publish(state, payload)
        finally:
            # 正常结束和中途报错都要记：报错前的改动同样真实存在于盘上
            try:
                await _record_changes(conn, sess, proj, before, before_truncated)
            except Exception as e:  # noqa: BLE001 - 记录失败不该盖掉 agent 的结果
                LOG.emit(pid, f"记录工作区改动失败：{e}", level="warn", source="files",
                         meta={"session_id": session_id})
                print(f"[warn] 记录工作区改动失败: {e}", flush=True)
    except asyncio.CancelledError:
        # 用户主动中止（POST /abort → task.cancel()）：CancelledError 从 provider.invoke
        # 的挂起点抛出，CLI 适配器已在此异常分支里连进程树杀掉子进程。这里吞下异常但不
        # 按「成功」收尾：订阅者收到 abort 事件，日志与调用留痕按已中止记录。
        aborted = True
        note = "已按你的要求中止本次运行，Agent 进程已被终止"
        _publish(state, {"type": "abort", "text": note})
        LOG.emit(pid, "用户中止了本次运行", level="warn", source="session",
                 meta={"session_id": session_id, "run_id": run_id})
    except Exception as e:  # noqa: BLE001
        error = f"agent 执行异常: {e}"
        LOG.emit(pid, error, level="error", source="session", meta={"session_id": session_id})
        _publish(state, {"type": "error", "text": error})
    finally:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        state.elapsed_ms = elapsed_ms
        state.usage = usage if isinstance(usage, dict) and usage else None
        # 先把耗时 / Token 挂到最近一条 agent 消息，再关连接与置 done（订阅者依赖这些字段）
        if conn is not None:
            try:
                if sess is not None:
                    R.MessageRepo.attach_run_meta(conn, session_id, elapsed_ms, usage)
            except Exception as e:  # noqa: BLE001 - 元信息失败不该盖掉审计留痕
                LOG.emit(pid, f"写入对话用量元信息失败：{e}", level="warn", source="session",
                         meta={"session_id": session_id})
            conn.close()
        state.done = True
        _notify(state)
        _maybe_cleanup(run_id, state)
        # Agent 自己吐了 error 事件也是失败：codebuddy 把「CLI 没给出任何输出」这类情况
        # 报成 error 事件而不是抛异常，若只看 exception，日志会把它写成「成功」——
        # 实时日志与调用留痕必须说同一件事，两处都用这个合并后的结论。
        failure = error or (f"Agent 返回错误：{agent_error}" if agent_error else "")
        if aborted and not failure:
            failure = "用户中止了本次运行"
        if aborted:
            LOG.emit(pid, f"运行结束（已中止，{elapsed_ms}ms，{len(state.buffer)} 个事件）",
                     level="warn", source="session",
                     meta={"session_id": session_id, "run_id": run_id})
        elif failure:
            LOG.emit(pid, f"运行结束（失败，{elapsed_ms}ms，{len(state.buffer)} 个事件）：{failure}",
                     level="error", source="session",
                     meta={"session_id": session_id, "run_id": run_id})
        else:
            LOG.emit(pid, f"运行结束（成功，{elapsed_ms}ms，{len(state.buffer)} 个事件）",
                     level="info", source="session",
                     meta={"session_id": session_id, "run_id": run_id})
        # 会话只要真的跑过一次就一定要留痕，失败也不例外（这是全平台最贵的一次调用）
        if sess is not None and agent is not None:
            body = "\n".join(t for t in texts if t and t.strip())
            if not body.strip() and failure:
                body = failure
            await audit.arecord_invocation(
                source="session", agent=agent, prompt=message, response=body,
                error=failure, elapsed_ms=elapsed_ms,
                event_count=len(state.buffer), project=proj, requirement=req,
                session_id=session_id, actor=state.actor, usage=usage,
            )


async def _record_changes(conn, session, project, before, before_truncated):
    """比对运行前后的快照，把这次实际改动落成一条记录；一个字都没改就不落。"""
    after, after_truncated = await asyncio.to_thread(SN.capture, project["disk_path"])
    changes = SN.diff_snapshots(before, after)
    if not changes:
        LOG.emit(project["id"], "工作区无文件变动", level="debug", source="files",
                 meta={"session_id": session["id"]})
        return None
    cs = R.ChangeSetRepo.create(
        conn, project["id"], session_id=session["id"],
        requirement_id=session["requirement_id"], source="agent",
        note=f"会话 #{session['id']} 运行产生",
        truncated=1 if (before_truncated or after_truncated) else 0,
    )
    for c in changes:
        R.ChangeSetRepo.add_file(conn, cs["id"], c["path"], c["status"],
                                 c["before"], c["after"], 1 if c["binary"] else 0)
    out = R.ChangeSetRepo.recount(conn, cs["id"])
    by_status: dict = {}
    for c in changes:
        by_status[c["status"]] = by_status.get(c["status"], 0) + 1
    detail = "，".join(f"{k} {v}" for k, v in sorted(by_status.items()))
    LOG.emit(project["id"], f"已记录本次改动 #{cs['id']}：{len(changes)} 个文件（{detail}）"
                            + ("，快照被上限截断" if (before_truncated or after_truncated) else ""),
             level="info", source="files",
             meta={"session_id": session["id"], "change_set_id": cs["id"]})
    return out
