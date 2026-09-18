"""会话服务端到端（逻辑层）：创建会话 → 发消息 → 后台 run → 事件落库 → 幂等回放。"""
import asyncio
import tempfile
from backend.db import get_conn, init_db
from backend import repositories as R
from backend import session_service as S
from backend.agent_runtime import AgentRegistry
from backend.adapters.fake import FakeAgentAdapter


def test_session_flow():
    AgentRegistry.register("fake", FakeAgentAdapter())
    conn = get_conn(); init_db(conn)
    d = tempfile.mkdtemp()
    ag = R.AgentRepo.create(conn, "fake", "fake", {})
    p = R.ProjectRepo.create(conn, "d", d)
    rq = R.RequirementRepo.create(conn, p["id"], "t", "")

    async def run():
        s = S.SessionService.create(conn, rq["id"])
        # 首次发送：新建 run 并后台执行
        mode, rid = S.SessionService.resolve_run(conn, s["id"], "把标题改成红色")
        assert mode == "new"
        events = [e async for e in S.SessionService.stream_run(rid)]
        assert any(e.get("type") == "edit" for e in events), "应收到 edit 事件"

        # 运行完成后消息落库
        msgs = R.MessageRepo.list_by_session(conn, s["id"])
        assert any(m["role"] == "agent" for m in msgs), "agent 消息应落库"

        # 幂等：同一 message 重连应走 replay，不新建 run、不重复写用户消息
        mode2, rid2 = S.SessionService.resolve_run(conn, s["id"], "把标题改成红色")
        assert mode2 == "replay"
        assert rid2 is None
        user_msgs = [m for m in msgs if m["role"] == "user"]
        assert len(user_msgs) == 1, "用户消息不应重复写入（否则会双改盘/双落库）"

        # 不同 message 应新建独立 run（不能静默丢弃第二条消息）
        mode3, rid3 = S.SessionService.resolve_run(conn, s["id"], "另一句话")
        assert mode3 == "new"
        assert rid3 != rid
        events3 = [e async for e in S.SessionService.stream_run(rid3)]
        assert any(e.get("type") == "edit" for e in events3)

        # 第二条完成后再重连同样走 replay
        mode4, rid4 = S.SessionService.resolve_run(conn, s["id"], "另一句话")
        assert mode4 == "replay"

    asyncio.run(run())
    conn.close()
