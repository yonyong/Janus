"""本地目录列举接口（网页版目录选择器）的 HTTP 冒烟。

覆盖新路由 `/api/admin/fs/dirs`：盘符/根视图、子目录列举、上级目录、
路径不存在 400、非目录 400、以及「必须管理员口令」这条权限边界。
这些全靠 FastAPI 的查询参数解析与 `Depends(require_admin)`，单测直调路由绕不过。

用法：coding-agent-platform/ 下执行
  python tools/smoke_fs_dirs.py
"""
import os
from pathlib import Path

import _smoke_common as S

s = S.boot(port=8034)
call, check, ADMIN = s.call, s.check, s.admin

norm = lambda p: os.path.abspath(str(p)).replace("\\", "/")  # noqa: E731

try:
    # ---------------- 盘符 / 根列表 ----------------
    st, out = call("GET", "/api/admin/fs/dirs", {"admin": ADMIN})
    check("盘符视图 200", st, 200)
    check("盘符视图当前路径为空", out["path"], "")
    check("盘符列表非空", bool(out["roots"]), True)
    check("盘符视图不返回子目录", out["dirs"], [])

    # ---------------- 列举工作区 ----------------
    st, out = call("GET", "/api/admin/fs/dirs", {"admin": ADMIN, "path": str(s.ws)})
    check("列举工作区 200", st, 200)
    check("当前路径已规范化", out["path"], norm(s.ws))
    names = [d["name"] for d in out["dirs"]]
    check("只列目录（src 在、README.md 不在）", ("src" in names, "README.md" in names), (True, False))
    check("子目录 path 为绝对路径", all(str(d["path"]).startswith("/") or ":/" in d["path"] for d in out["dirs"]), True)
    check("上级目录指向临时根", out["parent"], norm(s.tmp))

    # ---------------- 进入子目录 ----------------
    st, out = call("GET", "/api/admin/fs/dirs", {"admin": ADMIN, "path": str(s.ws / "src")})
    check("列举子目录 200", st, 200)
    check("子目录当前路径正确", out["path"], norm(s.ws / "src"))
    check("子目录的上级回到工作区", out["parent"], norm(s.ws))

    # ---------------- 非法路径 ----------------
    st, _ = call("GET", "/api/admin/fs/dirs", {"admin": ADMIN, "path": str(s.tmp / "nope")})
    check("不存在的目录 400", st, 400)
    st, _ = call("GET", "/api/admin/fs/dirs", {"admin": ADMIN, "path": str(s.ws / "README.md")})
    check("路径是文件而非目录 400", st, 400)

    # ---------------- 权限边界 ----------------
    st, _ = call("GET", "/api/admin/fs/dirs", {"path": str(s.ws)})
    check("无凭证 401", st, 401)
    st, _ = call("GET", "/api/admin/fs/dirs", {"admin": "wrong", "path": str(s.ws)})
    check("错口令 401", st, 401)
finally:
    s.stop()

raise SystemExit(s.finish())
