"""对话用量元信息：落库字段 + 会话 done 事件带回耗时 / Token。"""
import asyncio
import tempfile

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import session_service as S
from backend.agent_runtime import AgentRegistry
from backend.adapters.fake import FakeAgentAdapter


def test_message_attach_run_meta():
    conn = get_conn()
    init_db(conn)
    d = tempfile.mkdtemp()
    ag = R.AgentRepo.create(conn, "fake-meta", "fake", {})
    p = R.ProjectRepo.create(conn, "meta-proj", d)
    rq = R.RequirementRepo.create(conn, p["id"], "t", "")
    s = R.SessionRepo.create(conn, rq["id"], ag["id"], p["id"])
    R.MessageRepo.create(conn, s["id"], "user", "message", "hi")
    mid = R.MessageRepo.create(conn, s["id"], "agent", "message", "ok")
    attached = R.MessageRepo.attach_run_meta(
        conn, s["id"], elapsed_ms=1234,
        usage={"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
    )
    assert attached == mid
    row = R.MessageRepo.list_by_session(conn, s["id"])[-1]
    assert row["elapsed_ms"] == 1234
    assert row["prompt_tokens"] == 100
    assert row["completion_tokens"] == 20
    assert row["total_tokens"] == 120
    # 没有 agent 消息时静默
    s2 = R.SessionRepo.create(conn, rq["id"], ag["id"], p["id"])
    assert R.MessageRepo.attach_run_meta(conn, s2["id"], 1, {"prompt_tokens": 1}) is None
    conn.close()


def test_session_done_carries_usage_and_persists():
    AgentRegistry.register("fake", FakeAgentAdapter())
    conn = get_conn()
    init_db(conn)
    d = tempfile.mkdtemp()
    R.AgentRepo.create(conn, "fake", "fake", {})
    p = R.ProjectRepo.create(conn, "d", d)
    rq = R.RequirementRepo.create(conn, p["id"], "t", "")

    async def run():
        s = S.SessionService.create(conn, rq["id"])
        mode, rid = S.SessionService.resolve_run(conn, s["id"], "改一下")
        assert mode == "new"
        events = [e async for e in S.SessionService.stream_run(rid)]
        done = next(e for e in events if e.get("type") == "done")
        assert done.get("elapsed_ms") is not None and done["elapsed_ms"] >= 0
        assert done.get("usage", {}).get("prompt_tokens") == 12
        assert done.get("usage", {}).get("completion_tokens") == 8
        msgs = R.MessageRepo.list_by_session(conn, s["id"])
        agent = [m for m in msgs if m["role"] == "agent" and m["pane"] == "message"][-1]
        assert agent["elapsed_ms"] == done["elapsed_ms"]
        assert agent["prompt_tokens"] == 12
        assert agent["total_tokens"] == 20

    asyncio.run(run())
    conn.close()
