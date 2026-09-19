"""工作流文档落盘 + 附件 + 用例清单导出：HTTP 层冒烟。

覆盖工作流改造后的关键链路（文档必须落项目目录，Agent 才能按路径引用）：
- 需求文档 / 详细设计文档保存后镜像到 .janus/{需求目录}/requirement/；
- 需求附件上传（multipart 多文件）、列表、删除，实体在 .janus/{dir}/requirement/attach/ 下；
- 用例 CRUD 触发 .janus/{dir}/usecase/usercase.md 导出（含状态与用例附件路径）；
- AI 生成设计文档接口（fake 替身 agent）。

用法：coding-agent-platform/ 下执行
  python tools/smoke_workflow_docs.py
"""
import json
import urllib.parse
import urllib.request

import _smoke_common as S

BOUNDARY = "----capsmokesmoke"


def upload(s, path, qp, files):
    """multipart 上传：files 为 [(filename, bytes)]，字段名固定 files。"""
    body = b""
    for name, data in files:
        body += (
            f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="files"; '
            f'filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'
        ).encode("utf-8")
        body += data + b"\r\n"
    body += f"--{BOUNDARY}--\r\n".encode("utf-8")
    url = s.base + path + "?" + urllib.parse.urlencode(qp)
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={BOUNDARY}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


s = S.boot(port=8031)
call, check, ADMIN = s.call, s.check, s.admin

try:
    st, proj = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "smoke-docs", "disk_path": str(s.ws)})
    check("创建项目", st, 200)
    pid = proj["id"]
    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN}, {"project_ids": [pid]})
    check("签发令牌", st, 200)
    tk = tok["token"]

    # ---- 需求文档镜像（目录名 = 需求名称清洗，创建后固定） ----
    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "登录功能", "description": "支持手机号登录"})
    check("建需求", st, 200)
    rid = req["id"]
    d = req.get("dir_name") or ""
    check("返回需求目录名", bool(d), True)
    origin = s.ws / ".janus" / d / "requirement" / "origin.md"
    design = s.ws / ".janus" / d / "requirement" / "design.md"
    usercase = s.ws / ".janus" / d / "usecase" / "usercase.md"
    check("建单即镜像 origin.md", origin.read_text(encoding="utf-8"), "支持手机号登录")

    st, req = call("PATCH", f"/api/requirements/{rid}", {"token": tk},
                   {"description": "支持手机号+验证码登录，10 分钟有效", "source": "manual"})
    check("更新需求文档", st, 200)
    check("origin.md 已同步", origin.read_text(encoding="utf-8"),
          "支持手机号+验证码登录，10 分钟有效")

    # 需求名称创建后不可修改（.janus/ 目录名依据需求名称固定）
    st, _ = call("PATCH", f"/api/requirements/{rid}", {"token": tk}, {"title": "改名试试"})
    check("改名被拒绝", st, 400)

    st, req = call("PATCH", f"/api/requirements/{rid}", {"token": tk},
                   {"design_doc": "# 详细设计\n1. 新增 /api/login 接口"})
    check("保存详细设计文档", st, 200)
    check("design.md 已落盘", design.read_text(encoding="utf-8"),
          "# 详细设计\n1. 新增 /api/login 接口")

    # ---- 需求附件 ----
    st, rows = upload(s, f"/api/requirements/{rid}/attachments", {"token": tk},
                      [("proto.txt", b"prototype"), ("api-spec.txt", b"spec")])
    check("上传需求附件", (st, len(rows)), (200, 2))
    check("附件实体落盘",
          (s.ws / ".janus" / d / "requirement" / "attach" / "proto.txt").read_text(encoding="utf-8"),
          "prototype")
    st, rows = call("GET", f"/api/requirements/{rid}/attachments", {"token": tk})
    check("附件列表", (st, len(rows)), (200, 2))
    aid = rows[0]["id"]

    st, _ = call("DELETE", f"/api/attachments/{aid}", {"token": tk})
    check("删除附件", st, 200)
    st, rows = call("GET", f"/api/requirements/{rid}/attachments", {"token": tk})
    check("删除后剩 1 个", len(rows), 1)

    st, _ = call("GET", f"/api/requirements/{rid}/attachments", {})
    check("附件列表无令牌 401", st, 401)

    # ---- 用例清单导出 ----
    st, case = call("POST", f"/api/requirements/{rid}/cases", {"token": tk},
                    {"title": "验证码过期", "steps": "输入 11 分钟前发送的验证码", "expected": "提示已过期"})
    check("新增用例", st, 200)
    cid = case["id"]
    tc = usercase.read_text(encoding="utf-8")
    check("清单含用例标题", "验证码过期" in tc, True)
    check("清单含状态", "pending" in tc, True)
    check("清单含路径约定", ".janus" in tc and "test-result.md" in tc, True)

    st, rows = upload(s, f"/api/cases/{cid}/attachments", {"token": tk},
                      [("evidence.txt", b"expired-screenshot")])
    check("上传用例附件", (st, len(rows)), (200, 1))
    check("用例附件落盘",
          (s.ws / ".janus" / d / "usecase" / "attach" / "evidence.txt").read_text(encoding="utf-8"),
          "expired-screenshot")
    tc = usercase.read_text(encoding="utf-8")
    check("清单引用用例附件路径",
          f".janus/{d}/usecase/attach/evidence.txt" in tc, True)

    st, case = call("PATCH", f"/api/cases/{cid}", {"token": tk}, {"status": "failed", "note": "未提示过期"})
    check("勾选用例结果", st, 200)
    tc = usercase.read_text(encoding="utf-8")
    check("清单状态已同步", "failed" in tc, True)

    st, _ = call("DELETE", f"/api/cases/{cid}", {"token": tk})
    check("删除用例", st, 200)
    tc = usercase.read_text(encoding="utf-8")
    check("清单回到空态", "尚未配置任何用例" in tc, True)

    # ---- AI 生成设计文档（fake 替身）----
    class DesignStub:
        type = "design-stub"

        async def invoke(self, session, message, project_path):
            from backend.agent_runtime import AgentEvent
            yield AgentEvent(type="message", pane="message",
                             text="润色后的需求文档：\n# 详细设计\n## 涉及文件清单\n- backend/app.py")

    s.register_adapter(DesignStub())
    st, agent = call("POST", "/api/agents", {"admin": ADMIN},
                     {"name": "design-stub", "type": "design-stub", "config": {}})
    check("建替身 Agent", st, 200)
    st, out = call("POST", f"/api/requirements/{rid}/design", {"token": tk}, {"session_id": None})
    check("AI 生成设计文档", st, 200)
    check("设计正文可解析", "# 详细设计" in (out.get("content") or ""), True)

    # 权限：越权令牌不可见（用未签发令牌）
    st, _ = call("GET", f"/api/requirements/{rid}/workflow", {"token": "no-such-token"})
    check("无效令牌 401", st, 401)
finally:
    s.stop()

raise SystemExit(s.finish())
