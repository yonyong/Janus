"""工作台文件面板：路径越界拦截、列目录、读写、新建、重命名、删除，以及端点权限。

不依赖 httpx：直接调用 app 路由函数（Depends 只是默认值，显式传 db / allowed 即可），
文件本身落在 tempfile 建的真实目录里，验证的是真盘操作而非 mock。
"""
import os
import tempfile

from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import files as FS
from backend import app as app_module
from backend.models import FileCreateIn, FileRenameIn, FileWriteIn


def _db():
    conn = get_conn()
    init_db(conn)
    return conn


def _root():
    """建一个带目录/文件的临时工作区，返回 (root, 清理函数)。"""
    d = tempfile.mkdtemp(prefix="cap-files-")
    os.makedirs(os.path.join(d, "src"))
    with open(os.path.join(d, "README.md"), "w", encoding="utf-8") as f:
        f.write("# demo\n")
    return d


def _project(conn, root):
    return R.ProjectRepo.create(conn, "demo", root)["id"]


# ---------------- 路径安全 ----------------

def test_norm_rel_rejects_escape():
    for bad in ("../etc/passwd", "a/../../b", "/abs/path", "C:/windows"):
        try:
            FS.norm_rel(bad)
            assert False, f"应拒绝路径：{bad}"
        except FS.FsError:
            pass


def test_norm_rel_normalizes():
    assert FS.norm_rel("") == ""
    assert FS.norm_rel(".") == ""
    assert FS.norm_rel("./a//b/") == "a/b"
    assert FS.norm_rel("a\\b\\c") == "a/b/c"


def test_abs_path_containment():
    root = _root()
    inside = FS.abs_path(root, "src")
    assert os.path.realpath(inside) == os.path.realpath(os.path.join(root, "src"))
    try:
        FS.norm_rel("../outside")
        assert False, ".. 应被拒绝"
    except FS.FsError:
        pass
    # 软链接指向项目外时必须被拒绝（无权限建软链的环境跳过这一段）
    outside = tempfile.mkdtemp(prefix="cap-outside-")
    link = os.path.join(root, "escape")
    try:
        os.symlink(outside, link, target_is_directory=True)
    except (OSError, NotImplementedError, AttributeError):
        return
    try:
        FS.abs_path(root, "escape")
        assert False, "指向项目外的软链应被拒绝"
    except FS.FsError as e:
        assert e.code == 403


# ---------------- 列目录 ----------------

def test_list_dir_dirs_first():
    root = _root()
    with open(os.path.join(root, "b.txt"), "w", encoding="utf-8") as f:
        f.write("x")
    with open(os.path.join(root, "a.txt"), "w", encoding="utf-8") as f:
        f.write("y")
    out = FS.list_dir(root, "")
    names = [e["name"] for e in out["entries"]]
    assert out["path"] == "" and out["parent"] == ""
    assert names[0] == "src", f"目录应排在最前: {names}"
    assert names[1:] == ["a.txt", "b.txt", "README.md"], f"文件按名称排序: {names}"
    assert out["entries"][0]["type"] == "dir"
    assert out["entries"][1]["type"] == "file"
    assert out["entries"][1]["size"] == 1
    assert not out["truncated"]


def test_list_dir_missing_returns_404():
    root = _root()
    try:
        FS.list_dir(root, "nope")
        assert False, "不存在的目录应报错"
    except FS.FsError as e:
        assert e.code == 404


# ---------------- 文件名模糊检索 ----------------

def test_fuzzy_name_score_substring_and_subsequence():
    assert FS.fuzzy_name_score("FilePane.tsx", "pane") is not None
    assert FS.fuzzy_name_score("FilePane.tsx", "fptx") is not None
    assert FS.fuzzy_name_score("readme.md", "rdm") is not None
    assert FS.fuzzy_name_score("abc.txt", "xyz") is None
    # 子串得分应高于纯子序列
    sub = FS.fuzzy_name_score("echo.py", "echo") or 0
    seq = FS.fuzzy_name_score("echo.py", "ecpy") or 0
    assert sub > seq


def test_search_files_recursive_fuzzy():
    root = _root()
    os.makedirs(os.path.join(root, "pkg", "inner"), exist_ok=True)
    with open(os.path.join(root, "pkg", "inner", "UserService.ts"), "w", encoding="utf-8") as f:
        f.write("export {}\n")
    with open(os.path.join(root, "noise.txt"), "w", encoding="utf-8") as f:
        f.write("x\n")
    out = FS.search_files(root, "usrvc")
    names = [e["name"] for e in out["entries"]]
    assert "UserService.ts" in names
    assert "noise.txt" not in names
    # 目录名也可命中
    out2 = FS.search_files(root, "inne")
    assert any(e["name"] == "inner" for e in out2["entries"])


def test_search_files_endpoint():
    conn = _db()
    root = _root()
    pid = _project(conn, root)
    allowed = {pid}
    os.makedirs(os.path.join(root, "deep"), exist_ok=True)
    with open(os.path.join(root, "deep", "config.yaml"), "w", encoding="utf-8") as f:
        f.write("k: v\n")
    empty = app_module.search_project_files(pid=pid, q="", allowed=allowed, db=conn, limit=50)
    assert empty["entries"] == []
    out = app_module.search_project_files(pid=pid, q="cfgy", allowed=allowed, db=conn, limit=50)
    assert any(e["name"] == "config.yaml" for e in out["entries"])


# ---------------- 读 / 写 ----------------

def test_read_write_roundtrip():
    root = _root()
    r1 = FS.write_file(root, "src/new.py", "print(1)\n")
    assert r1["created"] is True
    r2 = FS.write_file(root, "src/new.py", "print(2)\n")
    assert r2["created"] is False
    got = FS.read_file(root, "src/new.py")
    assert got["content"] == "print(2)\n"
    assert got["binary"] is False and got["truncated"] is False


def test_write_requires_existing_parent():
    root = _root()
    try:
        FS.write_file(root, "no/such/dir/a.txt", "x")
        assert False, "上级目录不存在时应报错"
    except FS.FsError as e:
        assert e.code == 404


def test_read_binary_and_oversize():
    root = _root()
    with open(os.path.join(root, "bin.dat"), "wb") as f:
        f.write(b"\x00\x01\x02hello")
    binout = FS.read_file(root, "bin.dat")
    assert binout["binary"] is True and binout["content"] == ""

    big = os.path.join(root, "big.txt")
    with open(big, "w", encoding="utf-8") as f:
        f.write("a" * (FS.MAX_READ + 10))
    bigout = FS.read_file(root, "big.txt")
    assert bigout["truncated"] is True and bigout["content"] == ""
    assert "上限" in bigout["message"]


def test_read_dir_is_not_file():
    root = _root()
    try:
        FS.read_file(root, "src")
        assert False, "目录不能按文件读取"
    except FS.FsError as e:
        assert e.code == 400


# ---------------- 新建 / 重命名 / 删除 ----------------

def test_create_entry_conflict():
    root = _root()
    ent = FS.create_entry(root, "docs", "dir")
    assert ent["type"] == "dir"
    ent2 = FS.create_entry(root, "docs/note.md", "file")
    assert ent2["type"] == "file"
    try:
        FS.create_entry(root, "docs", "dir")
        assert False, "同名应冲突"
    except FS.FsError as e:
        assert e.code == 409


def test_rename_entry_and_conflict():
    root = _root()
    FS.create_entry(root, "a.txt", "file")
    FS.create_entry(root, "b.txt", "file")
    out = FS.rename_entry(root, "a.txt", "c.txt")
    assert out["path"] == "c.txt" and out["name"] == "c.txt"
    assert os.path.isfile(os.path.join(root, "c.txt"))
    try:
        FS.rename_entry(root, "c.txt", "b.txt")
        assert False, "重名应冲突"
    except FS.FsError as e:
        assert e.code == 409
    # 只允许单层名称，禁止借改名跨目录
    try:
        FS.rename_entry(root, "c.txt", "../escape.txt")
        assert False, "改名不应支持路径"
    except FS.FsError:
        pass


def test_delete_dir_requires_recursive():
    root = _root()
    FS.create_entry(root, "tmpfile.txt", "file")
    FS.delete_entry(root, "tmpfile.txt")
    assert not os.path.exists(os.path.join(root, "tmpfile.txt"))
    # src 目录非空（下面先塞一个文件）
    FS.create_entry(root, "src/x.py", "file")
    try:
        FS.delete_entry(root, "src")
        assert False, "非空目录不应被删除"
    except FS.FsError as e:
        assert e.code == 400
    FS.delete_entry(root, "src", recursive=True)
    assert not os.path.exists(os.path.join(root, "src"))
    # 根目录不允许删除
    try:
        FS.delete_entry(root, "")
        assert False, "根目录不可删"
    except FS.FsError:
        pass


# ---------------- 端点层：权限与路径翻译 ----------------

def test_endpoint_requires_project_permission():
    conn = _db()
    root = _root()
    pid = _project(conn, root)
    try:
        app_module.list_project_files(pid=pid, path="", allowed=set(), db=conn)
        assert False, "无权项目应 403"
    except HTTPException as e:
        assert e.status_code == 403


def test_endpoint_translates_bad_path():
    conn = _db()
    root = _root()
    pid = _project(conn, root)
    allowed = {pid}
    try:
        app_module.list_project_files(pid=pid, path="../../", allowed=allowed, db=conn)
        assert False, "越界路径应 400"
    except HTTPException as e:
        assert e.status_code == 400
    # 正常列目录
    out = app_module.list_project_files(pid=pid, path="", allowed=allowed, db=conn)
    assert any(e["name"] == "src" for e in out["entries"])
    # 写 / 读 / 建 / 改名 / 删 全链路
    app_module.write_project_file(pid=pid, body=FileWriteIn(path="src/hi.txt", content="hi"),
                                  allowed=allowed, db=conn)
    got = app_module.read_project_file(pid=pid, path="src/hi.txt", allowed=allowed, db=conn)
    assert got["content"] == "hi"
    app_module.create_project_entry(pid=pid, body=FileCreateIn(path="src/sub", type="dir"),
                                    allowed=allowed, db=conn)
    app_module.rename_project_entry(pid=pid, body=FileRenameIn(path="src/hi.txt", new_name="ho.txt"),
                                    allowed=allowed, db=conn)
    assert os.path.isfile(os.path.join(root, "src", "ho.txt"))
    app_module.delete_project_entry(pid=pid, path="src/sub", recursive=False,
                                    allowed=allowed, db=conn)
    assert not os.path.exists(os.path.join(root, "src", "sub"))


# ---------------- 原始字节流预览（raw） ----------------

def test_raw_meta_and_endpoint():
    conn = _db()
    root = _root()
    pid = _project(conn, root)
    allowed = {pid}
    with open(os.path.join(root, "doc.pdf"), "wb") as f:
        f.write(b"%PDF-1.4 fake-bytes")
    with open(os.path.join(root, "book.xlsx"), "wb") as f:
        f.write(b"PK\x03\x04 fake-xlsx")

    meta = FS.raw_meta(root, "doc.pdf")
    assert meta["media_type"] == "application/pdf"
    assert meta["size"] > 0
    assert FS.raw_meta(root, "book.xlsx")["media_type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml")

    # 端点层：返回 FileResponse，MIME 正确
    resp = app_module.read_project_file_raw(pid=pid, path="doc.pdf", download=False,
                                            allowed=allowed, db=conn)
    assert resp.media_type == "application/pdf"
    # 下载模式带附件头
    resp2 = app_module.read_project_file_raw(pid=pid, path="doc.pdf", download=True,
                                             allowed=allowed, db=conn)
    assert "attachment" in resp2.headers.get("content-disposition", "")

    # 缺失 / 越界 / 目录
    try:
        FS.raw_meta(root, "nope.pdf")
        assert False, "不存在的文件应 404"
    except FS.FsError as e:
        assert e.code == 404
    try:
        FS.norm_rel("../outside.pdf")
        assert False, ".. 应被拒绝"
    except FS.FsError:
        pass
    try:
        FS.raw_meta(root, "src")
        assert False, "目录不能预览"
    except FS.FsError as e:
        assert e.code == 400


def test_session_detail_exposes_disk_path():
    conn = _db()
    root = _root()
    pid = _project(conn, root)
    agent = R.AgentRepo.create(conn, "fake-1", "fake", {})
    req = R.RequirementRepo.create(conn, pid, "需求A", "描述")
    sess = R.SessionRepo.create(conn, req["id"], agent["id"], pid)
    from backend import auth
    tok = auth.TokenService.issue(conn, [pid])
    out = app_module.session_detail(sid=sess["id"], db=conn, token=tok, admin=None)
    assert out["project_id"] == pid
    assert out["disk_path"] == root
    assert out["requirement"]["title"] == "需求A"
    assert out["agent"]["name"] == "fake-1"
    # 无凭证 → 401
    try:
        app_module.session_detail(sid=sess["id"], db=conn, token=None, admin=None)
        assert False, "无凭证应 401"
    except HTTPException as e:
        assert e.status_code == 401
