"""工作流：阶段切换、用例 CRUD、归档验收汇总，以及接口权限。

与 test_files.py 同一套约定：不依赖 httpx，直接调 app 路由函数（Depends 只是默认值，
显式传 db / allowed 即可），数据落在临时库 + 临时目录里。
"""
import asyncio
import tempfile

from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import auth
from backend import repositories as R
from backend import app as app_module
from backend.models import (ArchiveIn, AiTaskIn, CaseBulkIn, CaseIn, CaseUpdate,
                            RequirementUpdate, StageIn)


def _db():
    conn = get_conn()
    init_db(conn)
    return conn


def _workspace():
    return tempfile.mkdtemp(prefix="cap-flow-")


def _fixture(conn):
    """建一个项目 + 需求，返回 (pid, rid, 允许访问的项目集合)。"""
    pid = R.ProjectRepo.create(conn, "demo", _workspace())["id"]
    rid = R.RequirementRepo.create(conn, pid, "免密登录", "用户希望免密登录")["id"]
    return pid, rid, {pid}


# ---------------- 表结构与默认值 ----------------

def test_requirement_defaults_to_clarify_stage():
    conn = _db()
    _, rid, _ = _fixture(conn)
    req = R.RequirementRepo.get(conn, rid)
    assert req["stage"] == "clarify"
    assert req["archived_at"] is None
    assert req["verdict"] == ""


def test_case_table_exists_on_fresh_db():
    conn = _db()
    _, rid, _ = _fixture(conn)
    assert R.TestCaseRepo.list_by_requirement(conn, rid) == []
    assert R.TestCaseRepo.stats(conn, rid) == {
        "pending": 0, "passed": 0, "failed": 0, "skipped": 0, "total": 0, "done": 0,
        "manual": 0, "manual_pending": 0,
    }


# ---------------- 用例仓储 ----------------

def test_case_crud_and_stats():
    conn = _db()
    _, rid, _ = _fixture(conn)
    a = R.TestCaseRepo.create(conn, rid, "登录成功", "1. 输入账号", "进入首页", source="manual")
    b = R.TestCaseRepo.create_many(conn, rid, [{"title": "密码错误"}, {"title": ""}], source="ai")
    assert len(b) == 1, "空标题应被跳过"
    assert b[0]["source"] == "ai"

    R.TestCaseRepo.update(conn, b[0]["id"], status="passed")
    stats = R.TestCaseRepo.stats(conn, rid)
    assert stats["total"] == 2 and stats["passed"] == 1 and stats["pending"] == 1 and stats["done"] == 1

    assert R.TestCaseRepo.delete(conn, a["id"]) is True
    assert R.TestCaseRepo.delete(conn, a["id"]) is False
    assert R.TestCaseRepo.stats(conn, rid)["total"] == 1


def test_case_update_ignores_unknown_status():
    conn = _db()
    _, rid, _ = _fixture(conn)
    c = R.TestCaseRepo.create(conn, rid, "x", status="not-a-status")
    assert c["status"] == "pending", "非法状态落库时归一为 pending"


def test_deleting_requirement_cascades_cases_and_sessions():
    conn = _db()
    pid, rid, _ = _fixture(conn)
    agent = R.AgentRepo.create(conn, "fake-flow", "fake", {})
    sess = R.SessionRepo.create(conn, rid, agent["id"], pid)
    R.MessageRepo.create(conn, sess["id"], "user", "message", "hi")
    R.TestCaseRepo.create(conn, rid, "用例")
    R.RequirementRepo.delete(conn, rid)
    assert R.RequirementRepo.get(conn, rid) is None
    assert conn.execute("SELECT COUNT(*) FROM test_cases").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0


# ---------------- 需求文档 / 阶段 ----------------

def test_update_requirement_doc_and_stage():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    out = app_module.update_requirement(rid, RequirementUpdate(description="# 背景\n\n免密"), allowed, conn)
    assert out["description"] == "# 背景\n\n免密"
    assert out["title"] == "免密登录", "未传的字段不应被清空"

    # 需求名称创建后不可修改（.janus/ 目录名依据需求名称固定）；传回原名称视为未改
    try:
        app_module.update_requirement(rid, RequirementUpdate(title="  换标题  "), allowed, conn)
        assert False, "改名应当被拒绝"
    except HTTPException as e:
        assert e.status_code == 400
    out = app_module.update_requirement(rid, RequirementUpdate(title="免密登录"), allowed, conn)
    assert out["title"] == "免密登录"


def test_requirement_dir_name_fixed_at_creation():
    """目录名创建时按需求名称生成并落库，同项目重名自动加后缀。"""
    from backend.docs import sanitize_dir_name, unique_dir_name

    conn = _db()
    pid = R.ProjectRepo.create(conn, "demo2", _workspace())["id"]
    r1 = R.RequirementRepo.create(conn, pid, "免密登录", "x", dir_name=unique_dir_name(conn, pid, "免密登录"))
    r2 = R.RequirementRepo.create(conn, pid, "免密登录", "x", dir_name=unique_dir_name(conn, pid, "免密登录"))
    assert r1["dir_name"] == "免密登录"
    assert r2["dir_name"] == "免密登录-2"
    # 非法字符清洗 + 空标题占位
    assert sanitize_dir_name('a/b\\c:d*e?"f<>g|h') == "a_b_c_d_e_f_g_h"
    assert sanitize_dir_name("  ") == "requirement"


def test_update_requirement_rejects_bad_input():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    for body in (RequirementUpdate(title="   "), RequirementUpdate(stage="nope")):
        try:
            app_module.update_requirement(rid, body, allowed, conn)
            assert False, "应当拒绝非法入参"
        except HTTPException as e:
            assert e.status_code == 400


def test_update_requirement_respects_permission():
    conn = _db()
    _, rid, _ = _fixture(conn)
    for allowed, status in ((set(), 403), ({999}, 403)):
        try:
            app_module.update_requirement(rid, RequirementUpdate(title="x"), allowed, conn)
            assert False, "应拒绝越权"
        except HTTPException as e:
            assert e.status_code == status
    try:
        app_module.update_requirement(99999, RequirementUpdate(title="x"), {1}, conn)
        assert False, "不存在的需求应 404"
    except HTTPException as e:
        assert e.status_code == 404


def test_set_stage_and_clear_archive_on_leave():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    app_module.set_requirement_stage(rid, StageIn(stage="verify"), allowed, conn)
    app_module.archive_requirement(rid, ArchiveIn(verdict="accepted", note="没问题"), allowed, conn)
    req = R.RequirementRepo.get(conn, rid)
    assert req["stage"] == "archive" and req["verdict"] == "accepted" and req["archived_at"]

    # 从归档退回其它阶段 = 撤销归档
    app_module.set_requirement_stage(rid, StageIn(stage="verify"), allowed, conn)
    req = R.RequirementRepo.get(conn, rid)
    assert req["stage"] == "verify" and req["verdict"] == "" and req["archived_at"] is None

    try:
        app_module.set_requirement_stage(rid, StageIn(stage="whatever"), allowed, conn)
        assert False, "非法阶段应 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_archive_requires_valid_verdict():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    try:
        app_module.archive_requirement(rid, ArchiveIn(verdict="maybe"), allowed, conn)
        assert False, "非法验收结论应 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_delete_requirement_checks_access():
    """删除需求此前没有任何鉴权，任何拿到接口地址的人都能删；现已按项目令牌校验。"""
    conn = _db()
    _, rid, allowed = _fixture(conn)
    try:
        app_module.delete_requirement(rid, set(), conn)
        assert False, "未授权应 403"
    except HTTPException as e:
        assert e.status_code == 403
    assert R.RequirementRepo.get(conn, rid) is not None
    assert app_module.delete_requirement(rid, allowed, conn) == {"ok": True}
    assert R.RequirementRepo.get(conn, rid) is None


# ---------------- 用例接口 ----------------

def test_case_endpoints_validate_input():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    for body in (CaseIn(title="  "), CaseIn(title="ok", status="weird")):
        try:
            app_module.create_case(rid, body, allowed, conn)
            assert False, "应当拒绝非法入参"
        except HTTPException as e:
            assert e.status_code == 400


def test_case_endpoints_permission():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    case = app_module.create_case(rid, CaseIn(title="一条用例", steps="1. 做", expected="好"), allowed, conn)
    assert case["status"] == "pending"
    try:
        app_module.update_case(case["id"], CaseUpdate(status="passed"), set(), conn)
        assert False, "越权应 403"
    except HTTPException as e:
        assert e.status_code == 403
    try:
        app_module.update_case(99999, CaseUpdate(status="passed"), allowed, conn)
        assert False, "不存在应 404"
    except HTTPException as e:
        assert e.status_code == 404
    assert app_module.update_case(case["id"], CaseUpdate(status="passed", note="ok"), allowed, conn)["status"] == "passed"
    assert app_module.delete_case(case["id"], allowed, conn) == {"ok": True}
    assert R.TestCaseRepo.list_by_requirement(conn, rid) == []


def test_bulk_create_cases_skips_blank():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    out = app_module.bulk_create_cases(rid, CaseBulkIn(cases=[
        CaseIn(title="A", steps="s", expected="e"),
        CaseIn(title="   "),
        CaseIn(title="B"),
    ]), allowed, conn)
    assert out["created"] == 2
    assert [c["title"] for c in out["cases"]] == ["A", "B"]
    assert all(c["source"] == "ai" for c in out["cases"])
    assert len(R.TestCaseRepo.list_by_requirement(conn, rid)) == 2


# ---------------- 工作流看板 / AI 任务前置校验 ----------------

def test_workflow_summary_shape():
    conn = _db()
    pid, rid, allowed = _fixture(conn)
    agent = R.AgentRepo.create(conn, "fake-flow", "fake", {})
    sess = R.SessionRepo.create(conn, rid, agent["id"], pid)
    R.MessageRepo.create(conn, sess["id"], "user", "message", "hi")
    R.TestCaseRepo.create(conn, rid, "用例A", status="passed")
    R.TestCaseRepo.create(conn, rid, "用例B", status="failed")

    out = app_module.requirement_workflow(rid, allowed, conn)
    assert out["stage"] == "clarify"
    assert out["cases"]["total"] == 2 and out["cases"]["passed"] == 1 and out["cases"]["failed"] == 1
    assert len(out["sessions"]) == 1 and out["sessions"][0]["messages"] == 1
    # 临时目录不是 git 仓库：改动列表必须显式标记为不可用，而不是伪装成「无改动」
    assert out["changes"]["available"] is False
    assert out["verdict"] == ""


def test_pick_agent_prefers_session_then_requirement_then_first():
    conn = _db()
    pid, rid, _ = _fixture(conn)
    assert app_module._pick_agent(conn, rid, None) is None, "库里没有 agent 时应返回 None"

    a1 = R.AgentRepo.create(conn, "a1", "fake", {})
    R.AgentRepo.create(conn, "a2", "fake", {})
    # 列表顺序即调度优先级：默认按创建顺序，取排位最前的
    assert app_module._pick_agent(conn, rid, None)["id"] == a1["id"]
    assert app_module._pick_agent(conn, rid, 99999)["id"] == a1["id"], "旧签名兼容"


def test_pick_agent_skips_over_quota_and_respects_order():
    """限额用满的 Agent 不可用：AI 任务顺位取下一个；拖拽排序决定优先级。"""
    conn = _db()
    pid, rid, _ = _fixture(conn)
    a1 = R.AgentRepo.create(conn, "a1", "fake", {})
    a2 = R.AgentRepo.create(conn, "a2", "fake", {})

    # 直接往留痕表里塞用量：a1 用满默认限额（1000 万），a2 不超
    conn.execute(
        "INSERT INTO agent_invocations(source,agent_id,agent_name,total_tokens) VALUES(?,?,?,?)",
        ("ai_cases", a1["id"], "a1", 10_000_000))
    conn.commit()
    assert app_module._pick_agent(conn, rid, None)["id"] == a2["id"], "超限的 a1 应被跳过"

    # 拖拽把 a2 挪到 a1 后面（即 a2 反而排后面）不影响结论：只有 a2 可用
    R.AgentRepo.reorder(conn, [a2["id"], a1["id"]])
    assert app_module._pick_agent(conn, rid, None)["id"] == a2["id"]

    # a2 也用满 → 全部超限，返回 None
    conn.execute(
        "INSERT INTO agent_invocations(source,agent_id,agent_name,total_tokens) VALUES(?,?,?,?)",
        ("ai_cases", a2["id"], "a2", 10_000_000))
    conn.commit()
    assert app_module._pick_agent(conn, rid, None) is None

    # 限额设为 0 = 不限额，立刻恢复可用
    R.AgentRepo.update(conn, a1["id"], token_limit=0)
    assert app_module._pick_agent(conn, rid, None)["id"] == a1["id"], "不限额的 Agent 恒可用"


def test_quota_is_daily_usage_not_lifetime():
    """日限额语义：只统计今日用量，昨日（历史）用量不计入、跨天自动重置。"""
    conn = _db()
    pid, rid, _ = _fixture(conn)
    a1 = R.AgentRepo.create(conn, "a1", "fake", {})
    a2 = R.AgentRepo.create(conn, "a2", "fake", {})

    # 历史用量再多也不算数：把「昨日」的调用塞到 a1 头上，仍应可用
    conn.execute(
        "INSERT INTO agent_invocations(source,agent_id,agent_name,total_tokens,created_at)"
        " VALUES(?,?,?,?,datetime('now','localtime','-1 day'))",
        ("ai_cases", a1["id"], "a1", 10_000_000))
    conn.commit()
    assert app_module._pick_agent(conn, rid, None)["id"] == a1["id"], "昨日用量不应触发日限额"

    # 今日用量达标才限额生效
    conn.execute(
        "INSERT INTO agent_invocations(source,agent_id,agent_name,total_tokens,created_at)"
        " VALUES(?,?,?,?,datetime('now','localtime'))",
        ("ai_cases", a1["id"], "a1", 10_000_000))
    conn.commit()
    assert app_module._pick_agent(conn, rid, None)["id"] == a2["id"], "今日用满才应跳过"

    # 富化视图里的用量口径同样只含今日
    enriched = {a["id"]: a for a in app_module._agents_enriched(conn)}
    assert enriched[a1["id"]]["used_tokens"] == 10_000_000
    assert enriched[a1["id"]]["available"] is False


def test_generate_cases_requires_non_empty_doc():
    """需求文档为空时应在调用 agent 之前就报 400，不把空上下文丢给模型。"""
    conn = _db()
    pid, rid, _ = _fixture(conn)
    R.AgentRepo.create(conn, "fake-flow", "fake", {})
    R.RequirementRepo.update(conn, rid, description="   ")
    tok = auth.TokenService.issue(conn, [pid])
    try:
        asyncio.run(app_module.generate_cases(rid, AiTaskIn(), token=tok, admin=None))
        assert False, "空需求文档应 400"
    except HTTPException as e:
        assert e.status_code == 400
        assert "需求文档为空" in e.detail

    # 项目越权 / 无效令牌同样是接口前置失败
    other = auth.TokenService.issue(conn, [pid + 1000])
    try:
        asyncio.run(app_module.generate_cases(rid, AiTaskIn(), token=other, admin=None))
        assert False, "越权应 403"
    except HTTPException as e:
        assert e.status_code == 403
