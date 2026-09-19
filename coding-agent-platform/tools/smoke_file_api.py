"""工作台文件接口 + 会话详情：HTTP 层冒烟（真实 uvicorn + 临时库 + 临时工作区）。

单元测试直接调路由函数，绕过了 FastAPI 的依赖注入与查询参数解析；
本脚本补上这一段：起真实 uvicorn，用 HTTP 覆盖列目录/读写/新建/重命名/删除、
路径越界、权限与会话详情。

用法：coding-agent-platform/ 下执行
  python tools/smoke_file_api.py       # 需要 .venv 已装 fastapi/uvicorn
"""
import _smoke_common as S
import urllib.parse
import urllib.request

s = S.boot(port=8021)
call, check, ADMIN = s.call, s.check, s.admin

try:
    st, proj = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "smoke", "disk_path": str(s.ws)})
    check("创建项目", st, 200)
    pid = proj["id"]

    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN}, {"project_ids": [pid]})
    check("签发令牌", st, 200)
    tk = tok["token"]

    st, data = call("GET", f"/api/projects/{pid}/files", {"token": tk, "path": ""})
    check("列根目录", st, 200)
    check("目录优先排序", [e["name"] for e in data["entries"]], ["src", "README.md"])

    st, data = call("GET", f"/api/projects/{pid}/file", {"token": tk, "path": "README.md"})
    check("读文件", (st, data["content"].strip()), (200, "# hi"))

    # raw 原始字节流预览（PDF/图片/表格/文档的预览通道）
    (s.ws / "doc.pdf").write_bytes(b"%PDF-1.4 smoke")
    raw_url = f"{s.base}/api/projects/{pid}/file/raw?token={tk}&path=doc.pdf"
    with urllib.request.urlopen(raw_url, timeout=30) as r:
        body = r.read()
        check("raw 预览 200", (r.status, body[:5]), (200, b"%PDF-"))
        check("raw MIME", r.headers.get("content-type", "").startswith("application/pdf"), True)
    dl_url = raw_url + "&download=true"
    with urllib.request.urlopen(dl_url, timeout=30) as r:
        check("raw 下载头", "attachment" in r.headers.get("content-disposition", ""), True)
    st, _ = call("GET", f"/api/projects/{pid}/file/raw", {"token": tk, "path": "nope.pdf"})
    check("raw 缺失 404", st, 404)
    st, _ = call("GET", f"/api/projects/{pid}/file/raw", {"path": "doc.pdf"})
    check("raw 无令牌 401", st, 401)

    # 路径内嵌 raw 路由（HTML 预览 iframe 用，相对资源在其下自然解析）
    nested_url = f"{s.base}/api/projects/{pid}/raw/src/app.py?token={tk}"
    with urllib.request.urlopen(nested_url, timeout=30) as r:
        check("raw 嵌套路由 200", (r.status, b"print" in r.read()), (200, True))
    st, _ = call("GET", f"/api/projects/{pid}/raw/{{}}".format(urllib.parse.quote("../secret")), {"token": tk})
    check("raw 嵌套越界 400", st, 400)
    st, _ = call("GET", f"/api/projects/{pid}/raw/ghost.md", {"token": tk})
    check("raw 嵌套缺失 404", st, 404)

    st, data = call("PUT", f"/api/projects/{pid}/file", {"token": tk},
                    {"path": "src/new.txt", "content": "hello"})
    check("新建并写入", (st, data["created"]), (200, True))

    st, data = call("POST", f"/api/projects/{pid}/files", {"token": tk}, {"path": "docs", "type": "dir"})
    check("新建目录", (st, data["type"]), (200, "dir"))

    st, data = call("POST", f"/api/projects/{pid}/files/rename", {"token": tk},
                    {"path": "src/new.txt", "new_name": "renamed.txt"})
    check("重命名", (st, data["path"]), (200, "src/renamed.txt"))

    st, data = call("DELETE", f"/api/projects/{pid}/files", {"token": tk, "path": "docs"})
    check("删除空目录", st, 200)

    # 非空目录：不带 recursive 应 400，带 recursive 应 200
    st, _ = call("POST", f"/api/projects/{pid}/files", {"token": tk}, {"path": "docs2", "type": "dir"})
    check("新建目录2", st, 200)
    call("PUT", f"/api/projects/{pid}/file", {"token": tk}, {"path": "docs2/a.txt", "content": "x"})
    st, data = call("DELETE", f"/api/projects/{pid}/files", {"token": tk, "path": "docs2"})
    check("非空目录拒绝", st, 400)
    st, data = call("DELETE", f"/api/projects/{pid}/files",
                    {"token": tk, "path": "docs2", "recursive": "true"})
    check("递归删除", st, 200)

    # 路径越界
    st, _ = call("GET", f"/api/projects/{pid}/file", {"token": tk, "path": "../secret"})
    check("读越界路径 400", st, 400)
    st, _ = call("DELETE", f"/api/projects/{pid}/files", {"token": tk, "path": "../../"})
    check("删越界路径 400", st, 400)
    st, _ = call("POST", f"/api/projects/{pid}/files", {"token": tk}, {"path": "../evil", "type": "file"})
    check("建越界路径 400", st, 400)

    # 权限
    st, _ = call("GET", f"/api/projects/{pid}/files", {"path": ""})
    check("无令牌 401", st, 401)

    # 会话详情
    st, agent = call("POST", "/api/agents", {"admin": ADMIN},
                     {"name": "smoke-agent", "type": "fake", "config": {}})
    check("建 Agent", st, 200)
    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "需求X", "description": "d"})
    check("建需求", st, 200)
    st, sess = call("POST", "/api/sessions", {"token": tk}, {"requirement_id": req["id"]})
    check("建会话", st, 200)
    st, detail = call("GET", f"/api/sessions/{sess['id']}", {"token": tk})
    # 需求标题创建时后端自动加 v-yyyyMMddHHmmss- 前缀
    check("会话详情", (st, detail["disk_path"] == str(s.ws),
                      detail["requirement"]["title"].removeprefix("v-").endswith("需求X")),
          (200, True, True))
    check("详情带阶段字段", detail["requirement"].get("stage"), "clarify")
    st, _ = call("GET", f"/api/sessions/{sess['id']}", {})
    check("会话详情无令牌 401", st, 401)
finally:
    s.stop()

raise SystemExit(s.finish())
