"""编码实现：工作区改动记录（快照差异）与回退。

覆盖两层：snapshots.py 的纯函数（快照/比对/回退，不碰数据库），
以及 app 路由层的权限、404、回退落库行为。
"""
import os
import tempfile

from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import snapshots as SN
from backend import app as app_module


def _db():
    conn = get_conn()
    init_db(conn)
    return conn


def _ws():
    """一个真实的临时工作区目录。"""
    return tempfile.mkdtemp(prefix="cap-cs-")


def _write(root, rel, text):
    ap = os.path.join(root, rel)
    os.makedirs(os.path.dirname(ap), exist_ok=True)
    with open(ap, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return ap


def _project(conn, root):
    return R.ProjectRepo.create(conn, "demo", root)["id"]


# ---------------- snapshots：快照与比对 ----------------

def test_capture_sees_added_modified_removed():
    root = _ws()
    _write(root, "a.txt", "one")
    _write(root, "sub/b.txt", "two")
    before, t1 = SN.capture(root)
    assert not t1 and set(before) == {"a.txt", "sub/b.txt"}

    _write(root, "a.txt", "one changed")
    os.remove(os.path.join(root, "sub", "b.txt"))
    _write(root, "c.txt", "new")
    after, _ = SN.capture(root)

    changes = {c["path"]: c for c in SN.diff_snapshots(before, after)}
    assert changes["a.txt"]["status"] == "modified"
    assert changes["a.txt"]["before"] == "one" and changes["a.txt"]["after"] == "one changed"
    assert changes["sub/b.txt"]["status"] == "removed"
    assert changes["sub/b.txt"]["after"] is None
    assert changes["c.txt"]["status"] == "added"
    assert changes["c.txt"]["before"] is None


def test_unchanged_workspace_has_no_changes():
    root = _ws()
    _write(root, "a.txt", "same")
    before, _ = SN.capture(root)
    after, _ = SN.capture(root)
    assert SN.diff_snapshots(before, after) == []


def test_ignore_dirs_are_skipped():
    root = _ws()
    _write(root, "src/main.py", "print(1)")
    _write(root, "node_modules/pkg/index.js", "noise")
    _write(root, ".git/config", "noise")
    _write(root, "__pycache__/x.pyc", "noise")
    snap, _ = SN.capture(root)
    assert set(snap) == {"src/main.py"}, f"应忽略依赖与缓存目录，实际 {sorted(snap)}"


def test_binary_file_记录指纹但不存内容():
    root = _ws()
    with open(os.path.join(root, "logo.png"), "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
    snap, _ = SN.capture(root)
    assert snap["logo.png"]["binary"] is True
    assert snap["logo.png"]["content"] is None
    assert snap["logo.png"]["digest"], "二进制文件应留指纹"


def test_binary_change_is_detected_by_digest():
    root = _ws()
    with open(os.path.join(root, "logo.png"), "wb") as f:
        f.write(b"\x89PNG\x00\x01")
    before, _ = SN.capture(root)
    with open(os.path.join(root, "logo.png"), "wb") as f:
        f.write(b"\x89PNG\x00\x02")
    after, _ = SN.capture(root)
    changes = SN.diff_snapshots(before, after)
    assert len(changes) == 1 and changes[0]["status"] == "modified"
    assert changes[0]["binary"] is True


def test_oversize_file_只记指纹():
    root = _ws()
    big = os.path.join(root, "big.txt")
    with open(big, "w", encoding="utf-8") as f:
        f.write("x" * (SN.MAX_FILE_BYTES + 10))
    snap, _ = SN.capture(root)
    assert snap["big.txt"]["oversize"] is True
    assert snap["big.txt"]["content"] is None


def test_capture_truncates_and_reports():
    root = _ws()
    for i in range(5):
        _write(root, f"f{i}.txt", "x")
    snap, truncated = SN.capture(root, max_files=2)
    assert truncated is True and len(snap) == 2


def test_unified_diff_renders_hunks():
    text = SN.unified("a\nb\n", "a\nc\n", "demo.txt", max_lines=100)
    assert "--- a/demo.txt" in text and "+++ b/demo.txt" in text
    assert "-b" in text and "+c" in text


def test_unified_diff_folds_huge_change():
    text = SN.unified("", "\n".join(str(i) for i in range(2000)), "big.txt", max_lines=50)
    assert "仅显示前 50 行" in text


def test_unified_diff_handles_pure_add_and_remove():
    assert "+hello" in SN.unified(None, "hello\n", "n.txt", 100)
    assert "-hello" in SN.unified("hello\n", None, "n.txt", 100)


# ---------------- snapshots：回退落盘 ----------------

def test_apply_revert_restores_modified_deletes_added_recreates_removed():
    root = _ws()
    entries = [
        {"path": "mod.txt", "before": "old", "after": "new", "binary": False},
        {"path": "add.txt", "before": None, "after": "brand new", "binary": False},
        {"path": "del.txt", "before": "bring back", "after": None, "binary": False},
    ]
    _write(root, "mod.txt", "new")
    _write(root, "add.txt", "brand new")

    out = SN.apply_revert(root, entries)
    assert all(r["ok"] for r in out), out
    assert open(os.path.join(root, "mod.txt"), encoding="utf-8").read() == "old"
    assert not os.path.exists(os.path.join(root, "add.txt")), "新增的文件回退应删除"
    assert open(os.path.join(root, "del.txt"), encoding="utf-8").read() == "bring back"


def test_apply_revert_skips_binary_but_reports():
    root = _ws()
    out = SN.apply_revert(root, [
        {"path": "logo.png", "before": None, "after": None, "binary": True},
        {"path": "ok.txt", "before": "x", "after": "y", "binary": False},
    ])
    by = {r["path"]: r for r in out}
    assert by["logo.png"]["ok"] is False and "无法回退" in by["logo.png"]["error"]
    assert by["ok.txt"]["ok"] is True


def test_apply_revert_creates_missing_parent_dirs():
    root = _ws()
    SN.apply_revert(root, [{"path": "deep/nested/f.txt", "before": "hi", "after": None,
                            "binary": False}])
    assert open(os.path.join(root, "deep", "nested", "f.txt"), encoding="utf-8").read() == "hi"


def test_apply_revert_refuses_escape_path():
    root = _ws()
    out = SN.apply_revert(root, [{"path": "../escape.txt", "before": "nope", "after": None,
                                  "binary": False}])
    assert out[0]["ok"] is False, "越界路径必须被拦下"


# ---------------- ChangeSetRepo ----------------

def test_create_add_file_recount():
    conn = _db()
    pid = _project(conn, _ws())
    cs = R.ChangeSetRepo.create(conn, pid, source="agent", note="跑了一次")
    R.ChangeSetRepo.add_file(conn, cs["id"], "a.txt", "modified", "old", "new")
    R.ChangeSetRepo.add_file(conn, cs["id"], "b.txt", "added", None, "x")
    R.ChangeSetRepo.add_file(conn, cs["id"], "c.txt", "removed", "y", None)
    got = R.ChangeSetRepo.recount(conn, cs["id"])
    assert (got["added"], got["modified"], got["removed"]) == (1, 1, 1)


def test_unknown_source_falls_back_to_agent():
    conn = _db()
    pid = _project(conn, _ws())
    cs = R.ChangeSetRepo.create(conn, pid, source="hacker")
    assert cs["source"] == "agent"


def test_list_by_project_orders_desc_and_filters_session():
    conn = _db()
    pid = _project(conn, _ws())
    R.ChangeSetRepo.create(conn, pid, session_id=1)
    second = R.ChangeSetRepo.create(conn, pid, session_id=2)
    rows = R.ChangeSetRepo.list_by_project(conn, pid)
    assert [r["id"] for r in rows] == [second["id"], second["id"] - 1]
    only2 = R.ChangeSetRepo.list_by_project(conn, pid, session_id=2)
    assert [r["id"] for r in only2] == [second["id"]]


def test_delete_by_session_removes_files_too():
    conn = _db()
    pid = _project(conn, _ws())
    cs = R.ChangeSetRepo.create(conn, pid, session_id=7)
    R.ChangeSetRepo.add_file(conn, cs["id"], "a.txt", "added", None, "x")
    assert R.ChangeSetRepo.delete_by_session(conn, 7) == 1
    left = conn.execute("SELECT COUNT(*) AS n FROM change_files WHERE change_set_id=?",
                        (cs["id"],)).fetchone()["n"]
    assert left == 0, "改动记录删了，文件行不能留下"


# ---------------- 路由层 ----------------

def _seeded(conn, root):
    """造一条「已发生过一次 agent 改动」的记录，返回 (pid, csid, 文件 path)。"""
    pid = _project(conn, root)
    before, _ = SN.capture(root)
    _write(root, "app.txt", "被 agent 改过了")
    after, _ = SN.capture(root)
    changes = SN.diff_snapshots(before, after)
    cs = R.ChangeSetRepo.create(conn, pid, source="agent")
    for c in changes:
        R.ChangeSetRepo.add_file(conn, cs["id"], c["path"], c["status"],
                                 c["before"], c["after"], 1 if c["binary"] else 0)
    cs = R.ChangeSetRepo.recount(conn, cs["id"])
    return pid, cs["id"], changes[0]["path"]


def test_list_change_sets_route():
    conn = _db()
    root = _ws()
    pid, csid, _ = _seeded(conn, root)
    rows = app_module.list_change_sets(pid, None, 50, {pid}, conn)
    assert len(rows) == 1
    assert rows[0]["id"] == csid and rows[0]["file_count"] == 1
    assert rows[0]["preview"][0]["path"] == "app.txt"


def test_list_change_sets_rejects_other_project():
    conn = _db()
    pid, _, _ = _seeded(conn, _ws())
    try:
        app_module.list_change_sets(pid, None, 50, {pid + 999}, conn)
    except HTTPException as e:
        assert e.status_code == 403
    else:
        raise AssertionError("越权应 403")


def test_change_set_detail_carries_diff():
    conn = _db()
    pid, csid, _ = _seeded(conn, _ws())
    d = app_module.change_set_detail(csid, {pid}, conn)
    assert d["files"][0]["revertible"] is True
    assert "被 agent 改过了" in d["files"][0]["diff"]


def test_change_set_detail_404_when_missing():
    conn = _db()
    try:
        app_module.change_set_detail(999999, {1}, conn)
    except HTTPException as e:
        assert e.status_code == 404
    else:
        raise AssertionError("不存在的记录应 404")


def test_revert_change_set_restores_disk_and_logs_a_record():
    conn = _db()
    root = _ws()
    _write(root, "app.txt", "原始内容")
    pid, csid, _ = _seeded(conn, root)
    assert open(os.path.join(root, "app.txt"), encoding="utf-8").read() == "被 agent 改过了"

    out = app_module.revert_change_set(csid, {pid}, conn)
    assert out["ok"] and out["reverted"] == 1
    assert open(os.path.join(root, "app.txt"), encoding="utf-8").read() == "原始内容"

    # 回退本身也留一条记录，且 before/after 互换
    new_cs = out["change_set"]
    assert new_cs["source"] == "revert" and f"#{csid}" in new_cs["note"]
    f = R.ChangeSetRepo.list_files(conn, new_cs["id"])[0]
    assert f["before"] == "被 agent 改过了" and f["after"] == "原始内容"

    rows = R.ChangeSetRepo.list_by_project(conn, pid)
    assert len(rows) == 2, "原记录保留 + 新增回退记录"


def test_revert_is_itself_revertible():
    """回退之后还能把回退再退回去 —— 历史里没有黑洞。"""
    conn = _db()
    root = _ws()
    _write(root, "app.txt", "原始内容")
    pid, csid, _ = _seeded(conn, root)
    first = app_module.revert_change_set(csid, {pid}, conn)
    again = app_module.revert_change_set(first["change_set"]["id"], {pid}, conn)
    assert again["ok"]
    assert open(os.path.join(root, "app.txt"), encoding="utf-8").read() == "被 agent 改过了"


def test_revert_change_file_only_touches_that_file():
    conn = _db()
    root = _ws()
    _write(root, "keep.txt", "keep-原始")
    pid = _project(conn, root)
    before, _ = SN.capture(root)
    _write(root, "keep.txt", "keep-被改")
    _write(root, "other.txt", "other-新")
    after, _ = SN.capture(root)
    cs = R.ChangeSetRepo.create(conn, pid, source="agent")
    for c in SN.diff_snapshots(before, after):
        R.ChangeSetRepo.add_file(conn, cs["id"], c["path"], c["status"],
                                 c["before"], c["after"], 0)
    cs = R.ChangeSetRepo.recount(conn, cs["id"])

    fid = [f for f in R.ChangeSetRepo.list_files(conn, cs["id"])
           if f["path"] == "keep.txt"][0]["id"]
    out = app_module.revert_change_file(cs["id"], fid, {pid}, conn)
    assert out["reverted"] == 1
    assert open(os.path.join(root, "keep.txt"), encoding="utf-8").read() == "keep-原始"
    assert open(os.path.join(root, "other.txt"), encoding="utf-8").read() == "other-新", \
        "只回退一个文件时另一个不能被动"


def test_revert_file_of_other_changeset_404():
    conn = _db()
    root = _ws()
    pid, csid, _ = _seeded(conn, root)
    other = R.ChangeSetRepo.create(conn, pid, source="agent")
    fid = R.ChangeSetRepo.list_files(conn, csid)[0]["id"]
    try:
        app_module.revert_change_file(other["id"], fid, {pid}, conn)
    except HTTPException as e:
        assert e.status_code == 404
    else:
        raise AssertionError("文件不属于该记录时应 404")


def test_revert_empty_changeset_400():
    conn = _db()
    pid = _project(conn, _ws())
    cs = R.ChangeSetRepo.create(conn, pid, source="agent")
    try:
        app_module.revert_change_set(cs["id"], {pid}, conn)
    except HTTPException as e:
        assert e.status_code == 400
    else:
        raise AssertionError("空记录没得回退，应 400")


def test_revert_binary_file_reports_skip():
    conn = _db()
    root = _ws()
    pid = _project(conn, root)
    cs = R.ChangeSetRepo.create(conn, pid, source="agent")
    R.ChangeSetRepo.add_file(conn, cs["id"], "logo.png", "modified", None, None, 1)
    R.ChangeSetRepo.recount(conn, cs["id"])
    out = app_module.revert_change_set(cs["id"], {pid}, conn)
    assert out["ok"] is False and out["skipped"] == 1 and out["change_set"] is None


def test_workflow_summary_includes_changeset_count():
    conn = _db()
    pid, csid, _ = _seeded(conn, _ws())
    req = app_module.create_requirement(
        pid, app_module.RequirementCreate(title="t", description="d"), {pid}, conn)
    R.ChangeSetRepo.create(conn, pid, requirement_id=req["id"], session_id=None)
    w = app_module.requirement_workflow(req["id"], {pid}, conn)
    assert w["change_sets"]["sets"] >= 1
