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


class _SlowAdapter:
    """慢速桩适配器：吐一个 delta 后长时间挂起，供中止测试打断。"""

    type = "slow-abortable"

    async def invoke(self, agent_row, message, project_path):
        from backend.agent_runtime import AgentEvent
        yield AgentEvent(type="delta", pane="message", text="开始")
        for _ in range(600):
            await asyncio.sleep(0.5)


def test_abort_run_is_a_real_abort_and_allows_retry():
    """用户中止必须是真中止：run 任务被取消、收到 abort 事件、且同一消息可重跑。

    回归自真实诉求：中止不能只是「页面不转了、后台 AI 还在跑」。后端以 task.cancel()
    终止 run（CLI 适配器在取消分支里连进程树杀子进程），这里验证会话层的语义：
    订阅者收到 abort 事件、run 结束、重复发送同一消息会新建 run 而不是回放半截输出。
    """
    AgentRegistry.register("slow-abortable", _SlowAdapter())
    conn = get_conn(); init_db(conn)
    d = tempfile.mkdtemp()
    ag = R.AgentRepo.create(conn, "slow-abortable", "slow-abortable", {})
    p = R.ProjectRepo.create(conn, "abort-proj", d)
    rq = R.RequirementRepo.create(conn, p["id"], "t", "")

    async def run():
        s = S.SessionService.create(conn, rq["id"])
        mode, rid = S.SessionService.resolve_run(conn, s["id"], "跑一个长任务")
        assert mode == "new"

        # 读到第一个 delta 就离开（模拟用户看着输出点了「停止运行」）
        got_delta = False
        async for e in S.SessionService.stream_run(rid):
            if e.get("type") == "delta":
                got_delta = True
                break
        assert got_delta

        # 中止：接口语义返回 run_id；随后 run 被取消、事件流以 abort + done 收尾
        aborted_rid, aborted_msg = S.SessionService.abort_run(s["id"])
        assert aborted_rid == rid
        assert aborted_msg == "跑一个长任务"

        events = [e async for e in S.SessionService.stream_run(rid)]
        assert any(e.get("type") == "abort" for e in events), events
        assert events[-1].get("type") == "done"
        assert not any(e.get("type") == "message" for e in events), "中止后不应有最终答复"

        # 等后台任务完全收尾（改动记录 / 审计在线程池里），run 不应再处于进行中
        for _ in range(80):
            if S.SessionService.active_run_for_session(s["id"])[0] is None:
                break
            await asyncio.sleep(0.05)
        assert S.SessionService.active_run_for_session(s["id"])[0] is None
        # 再点一次中止：没有进行中的 run，返回 (None, None)，不得误伤
        assert S.SessionService.abort_run(s["id"]) == (None, None)

        # 重试语义：被中止的运行什么都没落库（对话主线不掺半截输出），
        # 重新发送同一消息应新建 run，而不是把半截内容当完整结果回放
        msgs = R.MessageRepo.list_by_session(conn, s["id"])
        assert not any(m["role"] == "agent" for m in msgs), msgs
        mode2, rid2 = S.SessionService.resolve_run(conn, s["id"], "跑一个长任务")
        assert mode2 == "new"
        assert rid2 != rid
        # 清理第二次 run，别让长任务挂在事件循环里
        S.SessionService.abort_run(s["id"])
        async for _ in S.SessionService.stream_run(rid2):
            pass

    asyncio.run(run())
    conn.close()


# ---------------- 事件 → 实时日志的映射 ----------------

def _ev(type_, text=None, payload=None):
    """按真实链路构造一份事件：``(AgentEvent, json.loads(ev.to_json()))``。"""
    import json
    from backend.agent_runtime import AgentEvent
    e = AgentEvent(type=type_, pane="message", text=text, payload=payload)
    return e, json.loads(e.to_json())


def test_log_agent_event_maps_each_kind():
    from backend import logbus as L

    # 流式适配器（codebuddy）已经把 stderr 逐行实时推过了：这里不能再整段重复记一遍。
    # 事件 payload 嵌在事件字典的 payload 键下，读错层级会让同一批输出出现两次。
    L.reset()
    e, p = _ev("info", "第一行\n第二行", payload={"streamed": True})
    S._log_agent_event(9, 3, e, p)
    recs = L.snapshot(9)["records"]
    assert [r["source"] for r in recs] == ["session"]
    assert "已逐行实时记录" in recs[0]["text"]

    # 没有流式能力的适配器：由会话层逐行补记，内容一条不丢
    L.reset()
    e, p = _ev("info", "限流告警\n稍后重试")
    S._log_agent_event(9, 3, e, p)
    recs = L.snapshot(9)["records"]
    assert [r["text"] for r in recs] == ["限流告警", "稍后重试"]
    assert all(r["source"] == "agent" and r["level"] == "warn" for r in recs)

    # edit → 归到「文件改动」；error 用 error 级别；message 只留摘要不落正文
    L.reset()
    e, p = _ev("edit", "modified a.txt")
    p["diff"] = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n-old\n+new\n+more\n"
    S._log_agent_event(9, 3, e, p)
    e, p = _ev("error", "模型不可用")
    S._log_agent_event(9, 3, e, p)
    e, p = _ev("message", "这是一大段最终答复正文")
    S._log_agent_event(9, 3, e, p)
    recs = L.snapshot(9)["records"]
    assert (recs[0]["source"], recs[0]["text"]) == ("files", "工作区已改动 1 个文件（+2 / -1 行）")
    assert (recs[1]["source"], recs[1]["level"]) == ("session", "error")
    assert recs[2]["level"] == "debug" and "最终答复正文" not in recs[2]["text"]
    assert all(r["meta"] == {"session_id": 3} for r in recs)


def test_diff_summary_degrades_gracefully():
    d = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n-old\n+new\n+more\n"
    assert S._diff_summary(d) == "工作区已改动 1 个文件（+2 / -1 行）"
    # 非 git 仓库没有可用 diff：给中性描述，不要编造数字
    assert S._diff_summary("(无 git diff：目标项目非 git 仓库，或本次未产生改动)") == "工作区已改动"
    assert S._diff_summary("") == "工作区已改动"


class _ErrorOnlyAdapter:
    """只吐一个 error 事件的适配器：模拟 codebuddy「CLI 没有任何输出」这类失败。"""

    type = "err-only"

    async def invoke(self, agent_row, message, project_path):
        from backend.agent_runtime import AgentEvent
        yield AgentEvent(type="error", pane="message", text="模型不可用")


def test_run_with_error_event_is_logged_and_audited_as_failure():
    """Agent 吐 error 事件也算失败：实时日志与调用留痕必须说同一件事。

    回归自真实观感问题：codebuddy 把「CLI 没有输出」报成 error 事件而不是抛异常，
    只看 exception 会把它写成「运行结束（成功）」，调用留痕也跟着记成 success。
    """
    from backend import logbus as L
    L.reset()
    AgentRegistry.register("err-only", _ErrorOnlyAdapter())
    conn = get_conn(); init_db(conn)
    d = tempfile.mkdtemp()
    R.AgentRepo.create(conn, "err-agent", "err-only", {})
    p = R.ProjectRepo.create(conn, "err-proj", d)
    rq = R.RequirementRepo.create(conn, p["id"], "t", "")

    async def run():
        s = S.SessionService.create(conn, rq["id"])
        mode, rid = S.SessionService.resolve_run(conn, s["id"], "试试")
        assert mode == "new"
        async for _ in S.SessionService.stream_run(rid):
            pass
        # 留痕写在线程池里、且发生在 state.done 之后：等它落库再断言，否则是竞态
        for _ in range(80):
            if _last_invocation() is not None:
                break
            await asyncio.sleep(0.05)

    asyncio.run(run())
    texts = [r["text"] for r in L.snapshot(p["id"])["records"]]
    assert any(t.startswith("运行结束（失败") for t in texts), texts
    assert not any(t.startswith("运行结束（成功") for t in texts), texts
    assert any("Agent 报错" in t for t in texts)

    row = _last_invocation()
    assert row is not None, "会话运行必须留下调用留痕"
    assert row["status"] == "error"
    assert "模型不可用" in row["error"]
    conn.close()


def _last_invocation():
    """读最近一条调用留痕（独立连接，避开会话连接的读隔离）。"""
    c = get_conn()
    try:
        return c.execute("SELECT * FROM agent_invocations ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        c.close()
