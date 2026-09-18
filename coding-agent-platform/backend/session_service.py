"""会话/消息服务：创建会话、调用 agent provider、落库、产出事件流。

幂等与断线续传设计：
- 同一 (session_id, message) 对应唯一一次 agent 运行（run）。
- run 在后台 asyncio 任务中执行，与 SSE 连接生命周期解耦：客户端断线不会杀死
  正在运行的 agent，重连（同一 message）会订阅同一 run 的实时流，不会重复调用
  agent（避免重复改盘 / 重复落库）。
- run 完成后由 DB 回放（replay），内存中的 run 状态在最后一个订阅者离开后清理，
  不会无限增长。
"""
import asyncio
import datetime
import json
import subprocess
from . import repositories as R
from . import diff as D
from .db import get_conn
from .agent_runtime import AgentRegistry


# ---------------- 运行注册表（进程内，仅保留进行中 + 有订阅者的 run） ----------------
_RUNS: dict = {}          # run_id -> _RunState
_RUN_KEY: dict = {}       # (session_id, message) -> run_id
_TICK = object()          # 唤醒订阅者的空信号


class _RunState:
    def __init__(self, run_id, session_id, message):
        self.run_id = run_id
        self.session_id = session_id
        self.message = message
        self.buffer = []          # 已产出事件（dict）
        self.subscribers = []     # asyncio.Queue 列表
        self.done = False


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
            ags = R.AgentRepo.list(conn)
            if not ags:
                raise RuntimeError("未配置 coding agent，无法创建会话")
            agent_id = ags[0]["id"]
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
    def resolve_run(conn, session_id, message):
        """返回 (mode, run_id)。mode ∈ {'replay','live','new'}。

        - replay: 该消息已有完整 agent 输出，调用方应从 DB 回放（断线后重连已完成运行）。
        - live:   已有正在进行的 run，调用方应订阅其实时流（断线续传，不重复调用 agent）。
        - new:    尚无输出，已创建新 run 并在后台执行。
        """
        key = (session_id, message)
        existing = _RUN_KEY.get(key)
        if existing is not None and existing in _RUNS and not _RUNS[existing].done:
            return "live", existing

        # DB 侧判定是否已存在完成态运行
        msgs = R.MessageRepo.list_by_session(conn, session_id)
        last_user_idx = max((i for i, m in enumerate(msgs) if m["role"] == "user"), default=-1)
        completed = (
            last_user_idx >= 0
            and msgs[last_user_idx]["content"] == message
            and any(m["role"] == "agent" for m in msgs[last_user_idx + 1:])
        )
        if completed:
            return "replay", None

        # 新建 run：落库用户消息（每轮一次），后台执行 agent
        run_id = f"run-{session_id}-{datetime.datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        R.MessageRepo.create(conn, session_id, "user", "message", message, 0)
        state = _RunState(run_id, session_id, message)
        _RUNS[run_id] = state
        _RUN_KEY[key] = run_id
        asyncio.create_task(_run_agent(run_id, session_id, message))
        return "new", run_id

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
        yield {"type": "done"}


async def _run_agent(run_id, session_id, message):
    state = _RUNS.get(run_id)
    if state is None:
        return
    conn = None
    try:
        conn = get_conn()
        s = R.SessionRepo.get(conn, session_id)
        if s is None:
            _publish(state, {"type": "error", "text": "会话不存在，无法执行"})
            return
        agent = R.AgentRepo.get(conn, s["agent_id"])
        proj = R.ProjectRepo.get(conn, s["project_id"])
        if agent is None or proj is None:
            _publish(state, {"type": "error", "text": "关联 agent 或项目已不存在，无法执行"})
            return
        provider = AgentRegistry.get(agent["type"])
        async for ev in provider.invoke(agent, message, proj["disk_path"]):
            payload = json.loads(ev.to_json())
            if ev.type == "edit" and proj is not None:
                payload["diff"] = D.compute(proj["disk_path"])
            R.MessageRepo.create(
                conn, session_id, "agent", ev.pane,
                ev.text or "", 1 if ev.type == "edit" else 0,
            )
            _publish(state, payload)
    except Exception as e:  # noqa: BLE001
        _publish(state, {"type": "error", "text": f"agent 执行异常: {e}"})
    finally:
        if conn is not None:
            conn.close()
        state.done = True
        _notify(state)
        _maybe_cleanup(run_id, state)
