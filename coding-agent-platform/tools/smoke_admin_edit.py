"""管理员编辑项目 / Agent 配置的 HTTP 冒烟：PATCH + ?admin= 的真实链路。

为什么要有这一层：单测直接调路由函数，绕过 FastAPI 的依赖注入与查询参数解析，
而「编辑」恰恰全靠这两样——`?admin=` 是查询参数、`_ok=Depends(require_admin)` 是依赖。
所以这里起真实 uvicorn，用 HTTP 覆盖：部分更新语义、路径校验、重名冲突、
以及「非管理员一律 401」这几条最容易写漏的边界。

用法：coding-agent-platform/ 下执行
  python tools/smoke_admin_edit.py
"""
import json

import _smoke_common as S

s = S.boot(port=8023)
call, check, ADMIN = s.call, s.check, s.admin

try:
    # ---------------- 项目：编辑 ----------------
    st, proj = call("POST", "/api/projects", {"admin": ADMIN},
                    {"name": "原名", "disk_path": str(s.ws)})
    check("创建项目", st, 200)
    pid = proj["id"]

    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN},
                   {"project_ids": [pid]})
    tk = tok["token"]

    # 只提交 name：disk_path 必须保持原值
    st, out = call("PATCH", f"/api/projects/{pid}", {"admin": ADMIN}, {"name": "新名"})
    check("改名称", (st, out["name"]), (200, "新名"))
    check("未提交的路径不变", out["disk_path"], str(s.ws))

    # 改路径：新建一个带标记文件的真实目录再指过去，确认文件面板真的换了根
    other = s.tmp / "ws2"
    other.mkdir(exist_ok=True)
    (other / "marker.txt").write_text("hi\n", encoding="utf-8")
    st, out = call("PATCH", f"/api/projects/{pid}", {"admin": ADMIN}, {"disk_path": str(other)})
    check("改磁盘路径", (st, out["disk_path"]), (200, str(other)))
    st, out = call("GET", f"/api/projects/{pid}/files", {"token": tk})
    check("文件面板已按新路径解析", (st, [e["name"] for e in out["entries"]]), (200, ["marker.txt"]))

    st, out = call("PATCH", f"/api/projects/{pid}", {"admin": ADMIN},
                   {"disk_path": str(s.tmp / "does-not-exist")})
    check("不存在的路径 400", st, 400)
    st, out = call("GET", "/api/admin/projects", {"admin": ADMIN})
    check("被拒后路径未变", [p["disk_path"] for p in out if p["id"] == pid], [str(other)])

    st, _ = call("PATCH", f"/api/projects/{pid}", {"admin": ADMIN}, {"name": "   "})
    check("空名称 400", st, 400)
    st, _ = call("PATCH", "/api/projects/99999", {"admin": ADMIN}, {"name": "x"})
    check("项目不存在 404", st, 404)

    # 管理台前缀走的是同一份实现
    st, out = call("PATCH", f"/api/admin/projects/{pid}", {"admin": ADMIN}, {"name": "管理台改名"})
    check("管理台前缀同样可编辑", (st, out["name"]), (200, "管理台改名"))

    # 权限：编辑与创建、删除同级
    st, _ = call("PATCH", f"/api/projects/{pid}", None, {"name": "偷偷改"})
    check("无凭证 401", st, 401)
    st, _ = call("PATCH", f"/api/projects/{pid}", {"admin": "wrong"}, {"name": "偷偷改"})
    check("错口令 401", st, 401)
    st, _ = call("PATCH", f"/api/projects/{pid}", {"token": tk}, {"name": "业务员改"})
    check("仅持访问令牌 401", st, 401)

    # ---------------- Agent：编辑 ----------------
    st, ag = call("POST", "/api/agents", {"admin": ADMIN},
                  {"name": "cb-1", "type": "fake", "config": {"cmd": "old"}})
    check("注册 Agent", st, 200)
    aid = ag["id"]

    st, out = call("PATCH", f"/api/agents/{aid}", {"admin": ADMIN},
                   {"name": "cb-2", "type": "codebuddy", "config": {"cmd": "codebuddy", "args": ["-x"]}})
    check("改名称与类型", (st, out["name"], out["type"]), (200, "cb-2", "codebuddy"))
    check("config 落库为 JSON", json.loads(out["config"]),
          {"cmd": "codebuddy", "args": ["-x"]})

    # 只提交 config：其余字段保持原值
    st, out = call("PATCH", f"/api/agents/{aid}", {"admin": ADMIN}, {"config": {"cmd": "codebuddy"}})
    check("只改 config 时名称不变", (st, out["name"], out["type"]), (200, "cb-2", "codebuddy"))
    check("config 已更新", json.loads(out["config"]), {"cmd": "codebuddy"})

    st, ag2 = call("POST", "/api/agents", {"admin": ADMIN},
                   {"name": "taken", "type": "fake", "config": {}})
    st, _ = call("PATCH", f"/api/agents/{aid}", {"admin": ADMIN}, {"name": "taken"})
    check("改成已存在名称 409", st, 409)
    st, out = call("GET", "/api/agents")
    check("冲突后名称未变", [a["name"] for a in out if a["id"] == aid], ["cb-2"])

    st, _ = call("PATCH", f"/api/agents/{aid}", {"admin": ADMIN}, {"type": "  "})
    check("空类型 400", st, 400)
    st, _ = call("PATCH", "/api/agents/99999", {"admin": ADMIN}, {"name": "x"})
    check("Agent 不存在 404", st, 404)

    st, _ = call("PATCH", f"/api/agents/{aid}", None, {"name": "偷偷改"})
    check("无凭证 401", st, 401)
    st, _ = call("PATCH", f"/api/agents/{aid}", {"token": tk}, {"name": "业务员改"})
    check("仅持访问令牌 401", st, 401)

    # 空 body：不改任何字段，也不报错
    st, out = call("PATCH", f"/api/agents/{aid}", {"admin": ADMIN}, {})
    check("空 body 不改动", (st, out["name"], out["type"]), (200, "cb-2", "codebuddy"))
finally:
    s.stop()

raise SystemExit(s.finish())
