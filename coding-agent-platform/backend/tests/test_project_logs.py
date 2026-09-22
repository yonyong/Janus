"""项目磁盘日志目录：log_dir 校验、列文件、读增量、API 权限。"""
import os
import tempfile

from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import project_logs as PL
from backend import app as A
from backend.models import ProjectUpdate


def _conn():
    conn = get_conn()
    init_db(conn)
    return conn


def _tmpdir():
    return tempfile.mkdtemp(prefix="cap-plog-")


def _expect_http(fn, code: int):
    try:
        fn()
    except HTTPException as e:
        assert e.status_code == code, f"期望 {code}，实际 {e.status_code}：{e.detail}"
    else:
        raise AssertionError(f"期望 HTTPException({code})，但没有抛出")


def test_normalize_log_dir_requires_existing_subdir():
    root = _tmpdir()
    os.makedirs(os.path.join(root, "logs"))
    assert PL.normalize_log_dir(root, "logs") == "logs"
    assert PL.normalize_log_dir(root, "logs/") == "logs"
    assert PL.normalize_log_dir(root, "") is None
    assert PL.normalize_log_dir(root, None) is None
    try:
        PL.normalize_log_dir(root, "nope")
        assert False, "不存在的子目录应失败"
    except PL.ProjectLogError as e:
        assert e.code == 400
    try:
        PL.normalize_log_dir(root, "../outside")
        assert False, "越界应失败"
    except PL.ProjectLogError:
        pass


def test_project_update_log_dir_set_and_clear():
    conn = _conn()
    root = _tmpdir()
    os.makedirs(os.path.join(root, "var", "log"))
    p = R.ProjectRepo.create(conn, "demo", root)
    out = A.update_project(p["id"], ProjectUpdate(log_dir="var/log"), conn)
    assert out["log_dir"] == "var/log"
    # 未传 log_dir 不改
    out2 = A.update_project(p["id"], ProjectUpdate(name="demo2"), conn)
    assert out2["name"] == "demo2" and out2["log_dir"] == "var/log"
    # 显式清空
    cleared = A.update_project(p["id"], ProjectUpdate(log_dir=""), conn)
    assert cleared["log_dir"] in (None, "")
    conn.close()


def test_project_update_log_dir_rejects_escape():
    conn = _conn()
    root = _tmpdir()
    p = R.ProjectRepo.create(conn, "demo", root)
    _expect_http(lambda: A.update_project(p["id"], ProjectUpdate(log_dir="../x"), conn), 400)
    conn.close()


def test_list_and_read_log_files():
    conn = _conn()
    root = _tmpdir()
    log_dir = os.path.join(root, "logs")
    os.makedirs(log_dir)
    with open(os.path.join(log_dir, "app.log"), "w", encoding="utf-8") as f:
        f.write("2026-09-22 10:00:00 INFO hello\n")
        f.write("2026-09-22 10:00:01 ERROR boom\n")
    with open(os.path.join(log_dir, "skip.bin"), "wb") as f:
        f.write(b"\x00\x01")
    p = R.ProjectRepo.create(conn, "demo", root, log_dir="logs")
    allowed = {p["id"]}

    listing = A.list_project_log_files(p["id"], allowed, conn)
    assert listing["log_dir_configured"] is True
    names = [x["name"] for x in listing["files"]]
    assert "app.log" in names
    assert "skip.bin" not in names

    chunk = A.read_project_log_file(p["id"], path="app.log", offset=None, tail=True,
                                    max_bytes=PL.MAX_CHUNK, allowed=allowed, db=conn)
    assert "INFO hello" in chunk["content"]
    assert chunk["next_offset"] > 0

    # 增量：从 next_offset 再读应为空（文件未增长）
    empty = A.read_project_log_file(p["id"], path="app.log", offset=chunk["next_offset"],
                                    tail=False, max_bytes=PL.MAX_CHUNK, allowed=allowed, db=conn)
    assert empty["content"] == ""
    assert empty["eof"] is True
    conn.close()


def test_log_files_unconfigured_returns_empty():
    conn = _conn()
    root = _tmpdir()
    p = R.ProjectRepo.create(conn, "demo", root)
    listing = A.list_project_log_files(p["id"], {p["id"]}, conn)
    assert listing["log_dir_configured"] is False
    assert listing["files"] == []
    _expect_http(
        lambda: A.read_project_log_file(p["id"], path="x.log", offset=None, tail=True,
                                        max_bytes=PL.MAX_CHUNK, allowed={p["id"]}, db=conn),
        400,
    )
    conn.close()


def test_log_files_forbid_path_escape():
    conn = _conn()
    root = _tmpdir()
    os.makedirs(os.path.join(root, "logs"))
    # 项目外文件
    outside = tempfile.mkdtemp(prefix="cap-out-")
    with open(os.path.join(outside, "secret.log"), "w", encoding="utf-8") as f:
        f.write("secret\n")
    p = R.ProjectRepo.create(conn, "demo", root, log_dir="logs")
    _expect_http(
        lambda: A.read_project_log_file(p["id"], path="../secret.log", offset=None, tail=True,
                                        max_bytes=PL.MAX_CHUNK, allowed={p["id"]}, db=conn),
        400,
    )
    conn.close()


def test_log_files_require_project_access():
    conn = _conn()
    root = _tmpdir()
    os.makedirs(os.path.join(root, "logs"))
    p = R.ProjectRepo.create(conn, "demo", root, log_dir="logs")
    _expect_http(lambda: A.list_project_log_files(p["id"], set(), conn), 403)
    conn.close()
