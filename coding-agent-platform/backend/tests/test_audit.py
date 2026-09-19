"""审计留痕测试：操作日志 + Agent 调用留痕。

沿用仓库既有约定：不用 httpx，直接调函数（Depends 只是默认值），数据落临时库。
HTTP 层的覆盖在 tools/smoke_audit_api.py —— 那边才验证得到「中间件真的把身份绑上了」
与「路由真的写了日志」这两件事在真实请求下成立。
"""
import asyncio
import json
import sqlite3
import tempfile
from pathlib import Path

from backend.agent_runtime import AgentEvent, AgentRegistry
from backend.adapters.fake import FakeAgentAdapter
from backend.agent_test import probe_agent
from backend.config import CONFIG
from backend.db import get_conn, init_db
from backend.models import ProjectCreate
from backend import app as app_module
from backend import audit
from backend import repositories as R


def _db():
    conn = get_conn()
    init_db(conn)
    return conn


def _workspace():
    return tempfile.mkdtemp(prefix="cap-audit-")


# ---------------- 纯函数 ----------------

def test_mask_token_keeps_hint_without_exposing_secret():
    tok = "abcdefghijklmnopqrstuvwxyz"
    masked = audit.mask_token(tok)
    assert masked.startswith("abcdef") and masked.endswith("wxyz")
    assert tok not in masked
    assert audit.mask_token("") == ""
    assert audit.mask_token(None) == ""


def test_estimate_tokens_counts_cjk_and_ascii():
    assert audit.estimate_tokens("") == 0
    assert audit.estimate_tokens(None) == 0
    assert audit.estimate_tokens("汉语") == 1          # 2 字 × 0.7 ≈ 1.4 → 1
    assert audit.estimate_tokens("abcdefgh") == 2      # 8 字符 ÷ 4
    # 同样长度下中文的 token 数明显多于英文
    assert audit.estimate_tokens("中" * 40) > audit.estimate_tokens("a" * 40)


def test_extract_usage_reads_json_and_text_forms():
    assert audit.extract_usage('{"usage": {"prompt_tokens": 12, "completion_tokens": 34}}') == {
        "prompt_tokens": 12, "completion_tokens": 34}
    assert audit.extract_usage("input_tokens: 1,024  output_tokens=2,048") == {
        "prompt_tokens": 1024, "completion_tokens": 2048}
    assert audit.extract_usage("Tokens used: 300") == {"total_tokens": 300}
    assert audit.extract_usage("没有任何用量信息") is None
    assert audit.extract_usage("") is None


def test_tokens_of_prefers_real_usage_and_backfills_split():
    p, c, t, est = audit.tokens_of("问", "答", {"prompt_tokens": 7, "completion_tokens": 3})
    assert (p, c, t, est) == (7, 3, 10, 0)
    # 只报总数时，按字符占比回填入/出参，并标记为真实用量（total 是模型给的）
    p, c, t, est = audit.tokens_of("a" * 40, "b" * 40, {"total_tokens": 100})
    assert t == 100 and p + c == 100 and est == 0
    # 从输出文本里自动识别
    p, c, t, est = audit.tokens_of("hi", 'note: {"total_tokens": 50}')
    assert (t, est) == (50, 0)


def test_tokens_of_marks_estimated_when_no_usage():
    p, c, t, est = audit.tokens_of("你好", "你好呀")
    assert est == 1
    assert t == p + c and t > 0


def test_model_of_reads_config_model_and_args():
    assert audit.model_of({"config": '{"model": "gpt-4o"}'}) == "gpt-4o"
    assert audit.model_of({"config": {"args": ["--model", "claude-3"]}}) == "claude-3"
    assert audit.model_of({"config": {"args": ["--model=o3-mini"]}}) == "o3-mini"
    assert audit.model_of({"config": "不是 JSON"}) == ""
    assert audit.model_of({}) == ""


def test_identify_admin_token_and_anonymous():
    conn = _db()
    old = CONFIG.admin_token
    CONFIG.admin_token = "s3cret"
    try:
        assert audit.identify(conn, None, "s3cret")["actor_type"] == "admin"
        # 口令不对但带着令牌：照样按令牌留痕，不谎称匿名（匿名只在两样都没有时出现）
        assert audit.identify(conn, "t", "wrong")["actor_type"] == "token"
    finally:
        CONFIG.admin_token = old
    assert audit.identify(conn, None, None)["actor_type"] == "anonymous"

    tok = "audit-token-0123456789"
    R.TokenRepo.create(conn, tok, [1], None, "审计测试")
    who = audit.identify(conn, tok, None)
    assert who["actor_type"] == "token"
    assert who["actor"] != tok and tok not in who["actor"]   # 明文令牌绝不入日志
    assert who["token_id"] == R.TokenRepo.resolve(conn, tok)["id"]


def test_parse_scope_pulls_token_admin_and_forwarded_ip():
    scope = {
        "type": "http",
        "query_string": b"token=abc&admin=xyz",
        "headers": [(b"x-forwarded-for", b"10.0.0.1, 10.0.0.2")],
        "client": ("127.0.0.1", 1234),
    }
    assert audit._parse_scope(scope) == ("abc", "xyz", "10.0.0.1")
    bare = {"type": "http", "query_string": b"", "headers": [], "client": ("127.0.0.1", 9)}
    assert audit._parse_scope(bare) == (None, None, "127.0.0.1")


def test_middleware_binds_identity_for_downstream():
    """中间件把身份挂上后，下游（含同步路由所在的线程）都读得到。"""
    conn = _db()
    tok = "middleware-token-abcdefg"
    R.TokenRepo.create(conn, tok, [1], None, "")
    seen = {}

    async def downstream(scope, receive, send):
        seen.update(audit.actor())
        seen["ip"] = audit.current_ip()

    scope = {"type": "http", "query_string": f"token={tok}".encode(),
             "headers": [(b"x-forwarded-for", b"9.9.9.9")], "client": ("1.1.1.1", 1)}
    asyncio.run(audit.RequestMiddleware(downstream)(scope, None, None))
    assert seen["actor_type"] == "token"
    assert seen["ip"] == "9.9.9.9"
    # 出了中间件就恢复成匿名，不会串到别的请求上
    assert audit.actor()["actor_type"] == "anonymous"


# ---------------- 建表 ----------------

def test_audit_tables_exist_on_fresh_db():
    conn = _db()
    assert R.AuditLogRepo.query(conn, {})["total"] == 0
    assert R.AgentInvocationRepo.query(conn, {})["total"] == 0


# ---------------- 操作日志 ----------------

def test_record_operation_lands_and_filters():
    conn = _db()
    audit.record_operation(action="project.create", actor={"actor_type": "admin", "actor": "admin"},
                           ip="127.0.0.1", target_type="project", target_id=1,
                           target_name="demo", project_id=1, project_name="demo",
                           detail={"disk_path": "D:/x"})
    audit.record_operation(action="file.delete", category="file", status="failure",
                           error="目录非空", project_id=1, project_name="demo")

    page = R.AuditLogRepo.query(conn, {})
    assert page["total"] == 2
    assert page["items"][0]["action"] == "file.delete"       # 新的在前

    assert R.AuditLogRepo.query(conn, {"status": "failure"})["total"] == 1
    assert R.AuditLogRepo.query(conn, {"category": "project"})["total"] == 1
    assert R.AuditLogRepo.query(conn, {"actor_type": "admin"})["total"] == 1
    assert R.AuditLogRepo.query(conn, {"project_id": 1})["total"] == 2
    assert R.AuditLogRepo.query(conn, {"q": "目录非空"})["total"] == 1
    assert R.AuditLogRepo.query(conn, {"unknown_filter": "x"})["total"] == 2  # 未知字段忽略
    row = R.AuditLogRepo.query(conn, {"action": "project.create"})["items"][0]
    assert json.loads(row["detail"])["disk_path"] == "D:/x"


def test_operation_stats_share_the_same_filters():
    conn = _db()
    audit.record_operation(action="project.create", status="success")
    audit.record_operation(action="file.write", status="failure", error="磁盘只读")
    assert R.AuditLogRepo.stats(conn)["total"] == 2
    assert R.AuditLogRepo.stats(conn)["today"] == 2
    assert R.AuditLogRepo.stats(conn)["success"] == 1
    failure = R.AuditLogRepo.stats(conn, {"status": "failure"})
    assert (failure["total"], failure["failure"]) == (1, 1)


def test_operation_query_pages_and_lists_facets():
    conn = _db()
    for i in range(5):
        audit.record_operation(action="file.write", project_id=1, target_name=f"f{i}.txt")
    first = R.AuditLogRepo.query(conn, {}, limit=2, offset=0)
    second = R.AuditLogRepo.query(conn, {}, limit=2, offset=2)
    assert first["total"] == 5 and len(first["items"]) == 2
    assert {r["id"] for r in first["items"]}.isdisjoint({r["id"] for r in second["items"]})
    cats = {c["value"]: c["count"] for c in R.AuditLogRepo.categories(conn)}
    assert cats == {"file": 5}
    assert R.AuditLogRepo.actions(conn)[0]["value"] == "file.write"


def test_record_operation_never_raises_when_db_unavailable():
    """审计是旁路：写不进去只能告警，绝不能让用户的操作跟着失败。"""
    real = audit.get_conn

    def boom():
        raise RuntimeError("库没了")

    audit.get_conn = boom
    try:
        audit.record_operation(action="project.create")            # 不抛
        audit.record_invocation(source="probe", agent={"id": 1})   # 不抛
        asyncio.run(audit.arecord_invocation(source="probe", agent={"id": 1}))
    finally:
        audit.get_conn = real


# ---------------- 待写队列：失败留痕不能被写锁吃掉 ----------------
#
# 这一组覆盖真实踩到过的坑：路由报错时业务连接还握着未提交的写事务（sqlite3 不会因为
# IntegrityError 自动回滚），第二条连接去写审计表只会等到 busy_timeout 超时 —— 于是
# 「操作失败了」这条最该留下的记录反而被丢掉。现在的约定是：抢不到锁就排队，请求收尾后补写。

def _clear_deferred():
    """把队列清空（各测试用的是独立临时库，残留记录绝不能漏进下一个测试的库）。"""
    with audit._DEFERRED_LOCK:
        audit._DEFERRED.clear()


def _hold_write_lock(name: str = "dup"):
    """造一个「请求连接」：一次唯一约束冲突留下一笔未提交的写事务。"""
    conn = get_conn()
    R.AgentRepo.create(conn, name, "fake", {})
    try:
        R.AgentRepo.create(conn, name, "fake", {})
    except sqlite3.IntegrityError:
        pass
    return conn


def test_failure_log_survives_request_write_lock():
    conn = _db()
    _clear_deferred()

    req = _hold_write_lock()
    try:
        audit.record_operation(action="agent.create", status="failure",
                               error="agent 名称已存在: dup")
        # 抢不到锁：转入待写队列，而不是静默消失
        assert audit.pending_count() == 1
        assert R.AuditLogRepo.query(conn, {"action": "agent.create"})["total"] == 0
        # 锁还被占着，补写只能原样留着，不能丢
        assert audit.drain_deferred() == 0
        assert audit.pending_count() == 1
    finally:
        req.close()          # 请求收尾：事务回滚、写锁释放

    assert audit.drain_deferred() == 1
    assert audit.pending_count() == 0
    row = R.AuditLogRepo.query(conn, {"action": "agent.create"})["items"][0]
    assert row["status"] == "failure" and "名称已存在" in row["error"]


def test_invocation_log_uses_the_same_queue():
    """调用留痕走同一套兜底：抢不到锁也要补上，成功与失败一视同仁。"""
    conn = _db()
    _clear_deferred()

    req = _hold_write_lock("dup2")
    try:
        audit.record_invocation(source="probe", agent={"id": 1, "name": "a"},
                                prompt="你好", error="调用超时", elapsed_ms=10)
        assert audit.pending_count() == 1
    finally:
        req.close()

    assert audit.drain_deferred() == 1
    row = R.AgentInvocationRepo.query(conn, {})["items"][0]
    assert row["status"] == "error" and row["agent_name"] == "a"


def test_drain_drops_broken_record_without_blocking_the_queue():
    """某条记录本身写不进去时丢掉它就行，不能把整条队列永远卡在后面。"""
    conn = _db()
    _clear_deferred()
    real = audit._CREATORS["operation"]

    def broken(c, row):
        if row.get("action") == "boom":
            raise sqlite3.OperationalError("no such table: nope")
        return real(c, row)

    audit._CREATORS["operation"] = broken
    try:
        audit._defer("operation", {"action": "boom"})
        audit._defer("operation", {"action": "fine"})
        assert audit.drain_deferred() == 1        # 只有好的那条算写入成功
        assert audit.pending_count() == 0
        assert R.AuditLogRepo.query(conn, {"action": "fine"})["total"] == 1
        assert R.AuditLogRepo.query(conn, {"action": "boom"})["total"] == 0
    finally:
        audit._CREATORS["operation"] = real


def test_deferred_queue_is_capped():
    """队列有上限：数据库长期写不进去时，丢最旧的、保住最新的。"""
    _db()
    _clear_deferred()
    real = audit.DEFERRED_LIMIT
    audit.DEFERRED_LIMIT = 3
    try:
        for i in range(5):
            audit._defer("operation", {"action": f"a{i}"})
        assert audit.pending_count() == 3
        assert [row["action"] for _, row in audit._DEFERRED] == ["a2", "a3", "a4"]
    finally:
        audit.DEFERRED_LIMIT = real
        _clear_deferred()


# ---------------- Agent 调用留痕 ----------------

def test_record_invocation_captures_everything():
    conn = _db()
    audit.record_invocation(
        source="ai_cases",
        agent={"id": 3, "name": "cb", "type": "codebuddy", "config": {"model": "claude-3"}},
        prompt="设计用例", response="```json\n[]\n```",
        elapsed_ms=1234, event_count=2, project={"id": 1, "name": "demo"},
        requirement={"id": 2, "title": "免密登录"}, session_id=9,
        actor={"actor_type": "token", "actor": "abc123…wxyz"},
    )
    row = R.AgentInvocationRepo.query(conn, {})["items"][0]
    assert row["source"] == "ai_cases" and row["status"] == "success"
    assert row["model"] == "claude-3" and row["project_name"] == "demo"
    assert row["requirement_title"] == "免密登录" and row["session_id"] == 9
    assert row["elapsed_ms"] == 1234 and row["event_count"] == 2
    assert row["total_tokens"] == row["prompt_tokens"] + row["completion_tokens"] > 0


def test_invocation_failure_is_recorded_too():
    """不管成功还是失败都必须留痕 —— 这是本页面的核心要求。"""
    conn = _db()
    audit.record_invocation(source="session", agent={"id": 1, "name": "a", "type": "fake"},
                            prompt="改一下", error="agent 执行异常: 连接被拒绝",
                            elapsed_ms=50, timed_out=True, rate_limited=True,
                            actor={"actor_type": "admin", "actor": "admin"})
    row = R.AgentInvocationRepo.query(conn, {})["items"][0]
    assert row["status"] == "error"
    assert row["timed_out"] == 1 and row["rate_limited"] == 1
    assert "连接被拒绝" in row["error"]


def test_invocation_stats_summarise_tokens_and_latency():
    conn = _db()
    audit.record_invocation(source="session", agent={"id": 1}, prompt="a" * 40, response="b" * 40,
                            elapsed_ms=100, usage={"prompt_tokens": 10, "completion_tokens": 5})
    audit.record_invocation(source="probe", agent={"id": 1}, prompt="x", error="超时",
                            elapsed_ms=300, status="error")
    stats = R.AgentInvocationRepo.stats(conn)
    assert stats["total"] == 2 and stats["success"] == 1 and stats["error"] == 1
    assert stats["total_tokens"] == 15 and stats["estimated_rows"] == 1   # 第二条是估算的
    assert stats["avg_elapsed_ms"] == 200 and stats["max_elapsed_ms"] == 300
    assert stats["by_source"] == {"session": 1, "probe": 1}
    assert R.AgentInvocationRepo.stats(conn, {"status": "error"})["total"] == 1


def test_probe_agent_writes_invocation_with_context():
    """真实调用入口（一键测试）跑完必须留下一条记录，并带上归属信息。"""
    AgentRegistry.register("fake", FakeAgentAdapter())
    conn = _db()
    ws = _workspace()
    asyncio.run(probe_agent(
        {"id": 1, "name": "probe-agent", "type": "fake", "config": '{"model": "fake-1"}'},
        "你好", 10, workdir=ws, source="probe",
        context={"project_id": 7, "project_name": "示例项目", "requirement_id": 8,
                 "requirement_title": "示例需求", "session_id": 9,
                 "actor": {"actor_type": "admin", "actor": "admin"}},
    ))
    row = R.AgentInvocationRepo.query(conn, {})["items"][0]
    assert row["source"] == "probe" and row["model"] == "fake-1"
    assert row["project_id"] == 7 and row["requirement_title"] == "示例需求"
    assert row["session_id"] == 9 and row["actor_type"] == "admin"
    assert "已根据需求修改" in row["response"] and row["status"] == "success"


def test_probe_agent_records_failure_and_unknown_type():
    conn = _db()
    r = asyncio.run(probe_agent({"id": 2, "name": "bad", "type": "not-registered", "config": "{}"},
                                "hi", 1, source="probe"))
    assert r["ok"] is False
    row = R.AgentInvocationRepo.query(conn, {})["items"][0]
    assert row["status"] == "error" and "未注册的 agent 类型" in row["error"]


# ---------------- 路由接线（含失败留痕） ----------------

def test_create_project_route_writes_operation_log():
    conn = _db()
    app_module.create_project(ProjectCreate(name="审计项目", disk_path=_workspace()), conn, True)
    row = R.AuditLogRepo.query(conn, {"action": "project.create"})["items"][0]
    assert row["target_name"] == "审计项目" and row["status"] == "success"
    assert row["actor_type"] == "anonymous"      # 单测里没有中间件，如实记匿名


def test_failed_create_project_is_logged_as_failure():
    conn = _db()
    try:
        app_module.create_project(ProjectCreate(name="坏路径", disk_path="Z:/不存在的目录"), conn, True)
    except Exception:  # HTTPException(400)
        pass
    row = R.AuditLogRepo.query(conn, {"action": "project.create"})["items"][0]
    assert row["status"] == "failure" and "磁盘路径不存在" in row["error"]


def test_reveal_token_route_is_audited_without_leaking_secret():
    conn = _db()
    tok = "reveal-secret-token-9876543210"
    R.TokenRepo.create(conn, tok, [1], None, "给张三")
    tid = R.TokenRepo.resolve(conn, tok)["id"]
    app_module.admin_reveal_token(tid=tid, db=conn, request=None, _ok=True)
    audit_text = json.dumps(R.AuditLogRepo.query(conn, {"action": "token.reveal"})["items"],
                            ensure_ascii=False)
    assert "token.reveal" in audit_text
    assert tok not in audit_text            # 日志里只有脱敏串


def test_delete_requirement_route_records_target():
    conn = _db()
    pid = R.ProjectRepo.create(conn, "p", _workspace())["id"]
    rid = R.RequirementRepo.create(conn, pid, "要删的需求", "")["id"]
    app_module.delete_requirement(rid, {pid}, conn)
    row = R.AuditLogRepo.query(conn, {"action": "requirement.delete"})["items"][0]
    assert row["target_id"] == rid and row["target_name"] == "要删的需求"
    assert row["project_id"] == pid


# ---------------- 查询接口的辅助函数 ----------------

def test_paging_clamps_bad_values():
    assert app_module._paging(0, -5) == (50, 0)
    assert app_module._paging(100000, 10) == (200, 10)
    assert app_module._paging(20, 40) == (20, 40)


def test_day_range_expands_plain_dates_to_full_day():
    assert app_module._day_range("2026-09-19", "2026-09-20") == (
        "2026-09-19 00:00:00", "2026-09-20 23:59:59")
    assert app_module._day_range("2026-09-19T08:30:00", None) == ("2026-09-19 08:30:00", None)
    assert app_module._day_range(None, None) == (None, None)


def test_invocation_brief_trims_long_text():
    row = {"id": 1, "prompt": "甲" * 500, "response": "乙" * 500, "status": "success"}
    brief = app_module._invocation_brief(row)
    assert "prompt" not in brief and "response" not in brief
    assert len(brief["prompt_preview"]) == 160 and brief["prompt_chars"] == 500
    assert brief["response_chars"] == 500 and brief["status"] == "success"
