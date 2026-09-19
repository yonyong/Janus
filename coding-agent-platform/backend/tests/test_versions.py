"""需求澄清：文档历史版本（自动快照、查看、回退）。

与 test_workflow.py 同一套约定：直接调 app 路由函数，db / allowed 显式传入。
"""
import re
import tempfile

from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import app as app_module
from backend.models import RequirementCreate, RequirementUpdate


def _db():
    conn = get_conn()
    init_db(conn)
    return conn


def _fixture(conn, desc="用户希望免密登录"):
    pid = R.ProjectRepo.create(conn, "demo", tempfile.mkdtemp(prefix="cap-ver-"))["id"]
    req = app_module.create_requirement(
        pid, RequirementCreate(title="免密登录", description=desc), {pid}, conn)
    return pid, req["id"], {pid}


def _patch(conn, rid, allowed, **kw):
    return app_module.update_requirement(rid, RequirementUpdate(**kw), allowed, conn)


# ---------------- 自动快照 ----------------

def test_create_requirement_leaves_first_version():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    vs = app_module.list_requirement_versions(rid, allowed, conn)
    assert len(vs) == 1
    assert vs[0]["source"] == "create"
    assert vs[0]["chars"] == len("用户希望免密登录")
    assert vs[0]["current"] is True


def test_save_document_appends_version():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    _patch(conn, rid, allowed, description="改过的文档", source="manual")
    vs = app_module.list_requirement_versions(rid, allowed, conn)
    assert len(vs) == 2
    assert vs[0]["chars"] == len("改过的文档"), "新版应排在最前"
    assert vs[0]["current"] is True
    assert vs[1]["current"] is False


def test_ai_source_is_recorded():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    _patch(conn, rid, allowed, description="AI 润色后的文档", source="ai")
    assert app_module.list_requirement_versions(rid, allowed, conn)[0]["source"] == "ai"


def test_unknown_source_falls_back_to_manual():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    _patch(conn, rid, allowed, description="随便改改", source="hacker")
    assert app_module.list_requirement_versions(rid, allowed, conn)[0]["source"] == "manual"


def test_unchanged_content_does_not_add_version():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    _patch(conn, rid, allowed, description="用户希望免密登录")  # 与初始版完全相同
    assert len(app_module.list_requirement_versions(rid, allowed, conn)) == 1


def test_stage_only_change_does_not_add_version():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    app_module.set_requirement_stage(rid, app_module.StageIn(stage="build"), allowed, conn)
    assert len(app_module.list_requirement_versions(rid, allowed, conn)) == 1


def test_title_change_is_rejected():
    """需求名称创建后不可修改（.janus/ 目录名依据需求名称固定），改名 400。"""
    conn = _db()
    _, rid, allowed = _fixture(conn)
    try:
        _patch(conn, rid, allowed, title="免密登录（V2）")
        assert False, "改名应当被拒绝"
    except HTTPException as e:
        assert e.status_code == 400


# ---------------- 查看单个版本 ----------------

def test_get_version_returns_full_body():
    conn = _db()
    _, rid, allowed = _fixture(conn, "第一版内容")
    _patch(conn, rid, allowed, description="第二版内容")
    old = app_module.list_requirement_versions(rid, allowed, conn)[1]
    v = app_module.get_requirement_version(rid, old["id"], allowed, conn)
    assert v["description"] == "第一版内容"
    assert re.match(r"^v-\d{14}-免密登录$", v["title"])


def test_get_version_of_other_requirement_404():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    _, rid2, allowed2 = _fixture(conn, "另一个需求")
    other = app_module.list_requirement_versions(rid2, allowed2, conn)[0]
    try:
        # 两个需求都授权了，但 vid 属于另一个需求 → 仍然 404，不能跨需求读
        app_module.get_requirement_version(rid, other["id"], allowed | allowed2, conn)
    except HTTPException as e:
        assert e.status_code == 404
    else:
        raise AssertionError("跨需求的版本 id 不该能读到")


# ---------------- 回退 ----------------

def test_restore_brings_back_old_content_and_logs_a_revert_version():
    conn = _db()
    _, rid, allowed = _fixture(conn, "第一版内容")
    _patch(conn, rid, allowed, description="第二版内容")
    v1 = app_module.list_requirement_versions(rid, allowed, conn)[1]

    out = app_module.restore_requirement_version(rid, v1["id"], allowed, conn)
    assert out["description"] == "第一版内容"

    vs = app_module.list_requirement_versions(rid, allowed, conn)
    assert len(vs) == 3, "回退本身也要留一版"
    assert vs[0]["source"] == "revert"
    assert "回退到版本" in vs[0]["note"]
    assert vs[0]["chars"] == len("第一版内容")


def test_restore_is_itself_restorable():
    """回退不该销毁历史：回退之后还能回退回「回退之前」的那一版。"""
    conn = _db()
    _, rid, allowed = _fixture(conn, "AAAA")
    _patch(conn, rid, allowed, description="BBB")
    v_a = app_module.list_requirement_versions(rid, allowed, conn)[1]
    assert v_a["chars"] == 4, "第 1 版应是初始的 AAAA"

    app_module.restore_requirement_version(rid, v_a["id"], allowed, conn)
    assert R.RequirementRepo.get(conn, rid)["description"] == "AAAA"

    # 回退产生的新版本也在历史里，于是能把 B 再找回来
    v_b = [v for v in app_module.list_requirement_versions(rid, allowed, conn)
           if v["preview"].startswith("BBB")][0]
    app_module.restore_requirement_version(rid, v_b["id"], allowed, conn)
    assert R.RequirementRepo.get(conn, rid)["description"] == "BBB"


def test_restore_missing_version_404():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    try:
        app_module.restore_requirement_version(rid, 9999, allowed, conn)
    except HTTPException as e:
        assert e.status_code == 404
    else:
        raise AssertionError("不存在的版本应 404")


def test_version_endpoints_respect_permission():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    other = {allowed.copy().pop() + 1000}
    for fn in (lambda: app_module.list_requirement_versions(rid, other, conn),
               lambda: app_module.restore_requirement_version(rid, 1, other, conn)):
        try:
            fn()
        except HTTPException as e:
            assert e.status_code == 403
        else:
            raise AssertionError("越权应 403")


# ---------------- 级联 ----------------

def test_deleting_requirement_removes_versions():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    _patch(conn, rid, allowed, description="第二版")
    app_module.delete_requirement(rid, allowed, conn)
    left = conn.execute("SELECT COUNT(*) AS n FROM requirement_versions WHERE requirement_id=?",
                        (rid,)).fetchone()["n"]
    assert left == 0


def test_create_if_changed_skips_duplicate():
    conn = _db()
    _, rid, _ = _fixture(conn)
    # 创建时标题已被自动加 v-时间戳- 前缀，对比用实际落库的标题
    actual_title = R.RequirementRepo.get(conn, rid)["title"]
    assert R.RequirementVersionRepo.create_if_changed(conn, rid, actual_title, "用户希望免密登录") is None
    made = R.RequirementVersionRepo.create_if_changed(conn, rid, actual_title, "换了内容")
    assert made is not None and made["description"] == "换了内容"


def test_backfill_gives_legacy_requirement_an_initial_version():
    """版本功能上线前建的需求，重新初始化时应补一条初始版本，否则历史抽屉是空的。"""
    conn = _db()
    _, rid, allowed = _fixture(conn)
    conn.execute("DELETE FROM requirement_versions WHERE requirement_id=?", (rid,))
    conn.commit()
    assert app_module.list_requirement_versions(rid, allowed, conn) == []

    init_db(conn)
    vs = app_module.list_requirement_versions(rid, allowed, conn)
    assert len(vs) == 1
    assert vs[0]["source"] == "create"
    assert vs[0]["chars"] == len("用户希望免密登录")


def test_backfill_is_idempotent_and_leaves_existing_history_alone():
    conn = _db()
    _, rid, allowed = _fixture(conn)
    _patch(conn, rid, allowed, description="第二版")
    before = [v["id"] for v in app_module.list_requirement_versions(rid, allowed, conn)]

    init_db(conn)
    init_db(conn)
    after = [v["id"] for v in app_module.list_requirement_versions(rid, allowed, conn)]
    assert after == before, "已有版本的需求不该被回填插入新行"


# ---------------- 新建需求标题自动加 v-yyyyMMddHHmmss- 前缀 ----------------

def test_create_requirement_adds_timestamp_prefix():
    conn = _db()
    pid = R.ProjectRepo.create(conn, "demo", tempfile.mkdtemp(prefix="cap-ver-"))["id"]
    req = app_module.create_requirement(
        pid, RequirementCreate(title="免密登录", description=""), {pid}, conn)
    assert re.match(r"^v-\d{14}-免密登录$", req["title"]), req["title"]
    # 首个版本记录的也应是带前缀的标题
    vs = app_module.list_requirement_versions(req["id"], {pid}, conn)
    assert vs[0]["title"] == req["title"]


def test_create_requirement_keeps_existing_prefix():
    conn = _db()
    pid = R.ProjectRepo.create(conn, "demo", tempfile.mkdtemp(prefix="cap-ver-"))["id"]
    full = "v-20260919010101-免密登录"
    req = app_module.create_requirement(
        pid, RequirementCreate(title=full), {pid}, conn)
    assert req["title"] == full, "已带前缀的标题不应被二次加前缀"


# ---------------- 弹性工作流：需求模式（full / lite） ----------------

def test_create_full_mode_defaults():
    """默认（或显式 full）创建：标准四阶段，从需求澄清开始。"""
    conn = _db()
    pid = R.ProjectRepo.create(conn, "demo", tempfile.mkdtemp(prefix="cap-ver-"))["id"]
    req = app_module.create_requirement(
        pid, RequirementCreate(title="标准需求", mode="full"), {pid}, conn)
    assert req["mode"] == "full"
    assert req["stage"] == "clarify"


def test_create_lite_mode_starts_at_build():
    """轻量需求：mode=lite，跳过澄清与用例，直接落在编码实现阶段。"""
    conn = _db()
    pid = R.ProjectRepo.create(conn, "demo", tempfile.mkdtemp(prefix="cap-lite-"))["id"]
    req = app_module.create_requirement(
        pid, RequirementCreate(title="改提示文案", description="改一行提示", mode="lite"), {pid}, conn)
    assert req["mode"] == "lite"
    assert req["stage"] == "build"


def test_create_invalid_mode_falls_back_to_full():
    """非法 mode 不该炸接口：回落 full 标准流程。"""
    conn = _db()
    pid = R.ProjectRepo.create(conn, "demo", tempfile.mkdtemp(prefix="cap-lite-"))["id"]
    req = app_module.create_requirement(
        pid, RequirementCreate(title="乱传模式", mode="hack"), {pid}, conn)
    assert req["mode"] == "full"
    assert req["stage"] == "clarify"
