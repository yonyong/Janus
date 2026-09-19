"""工作流接口 HTTP 冒烟：需求文档 / 用例 CRUD / 阶段切换 / 归档验收 / AI 任务链路。

为什么要有这一层：单元测试直接调路由函数，绕过了 FastAPI 的依赖注入与查询参数解析，
而 AI 任务还多一层「取 agent → 调适配器 → 收集回复 → 解析 JSON → 落库」的链路。

AI 的部分用**桩适配器**替代真实模型：它在进程内直接吐出一段合法的用例 JSON
（真实模型的措辞差异由 backend/tests/test_ai_tasks.py 的解析单测覆盖）。
这样链路本身可确定性地验证，不需要外网、不烧 token、不受模型波动影响。

用法：coding-agent-platform/ 下执行
  python tools/smoke_workflow_api.py
"""
import _smoke_common as S

CASES_REPLY = """我按需求设计了以下用例：

```json
[
  {"title": "正确的账号密码可登录成功", "steps": "1. 打开登录页\\n2. 输入正确账号密码\\n3. 点击登录",
   "expected": "进入首页并显示用户名"},
  {"title": "密码错误提示且不跳转", "steps": "1. 输入正确账号 + 错误密码\\n2. 点击登录",
   "expected": "提示账号或密码错误，停留在登录页"},
  {"title": "连续错误 5 次后锁定", "steps": "1. 连续 5 次输错密码",
   "expected": "账号锁定 10 分钟并给出提示"}
]
```
"""

POLISH_REPLY = """润色后的需求文档：
```markdown
## 背景

用户登录流程繁琐，需要降低门槛。

## 目标

- 支持免密登录

## 验收要点

- 3 秒内完成登录
```
"""


class StubAgentAdapter:
    """桩 agent：不启动任何外部进程，按提示词返回固定的模型输出。

    文档里带 GARBAGE 标记时故意答非所问，用来验证「模型答了但解析不出来」这条分支。
    """

    type = "stub"

    async def invoke(self, agent_row, message, project_path):
        from backend.agent_runtime import AgentEvent

        if "GARBAGE" in (message or ""):
            text = "抱歉，我无法根据该需求生成用例。"
        elif "用例" in (message or ""):
            text = CASES_REPLY
        else:
            text = POLISH_REPLY
        yield AgentEvent(type="status", pane="message", text="stub agent 开始处理")
        yield AgentEvent(type="message", pane="message", text=text)


s = S.boot(port=8022)
s.register_adapter(StubAgentAdapter())
call, check, ADMIN = s.call, s.check, s.admin

try:
    st, proj = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "flow", "disk_path": str(s.ws)})
    check("创建项目", st, 200)
    pid = proj["id"]
    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN}, {"project_ids": [pid]})
    tk = tok["token"]
    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "免密登录", "description": ""})
    check("建需求", st, 200)
    rid = req["id"]
    check("新需求默认处于需求澄清", req["stage"], "clarify")
    check("新需求默认标准模式", req["mode"], "full")

    # ---------------- 弹性工作流：模式（full / lite） ----------------
    st, lite = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                    {"title": "改提示文案", "description": "改一行提示", "mode": "lite"})
    check("建轻量需求", st, 200)
    check("轻量需求落在编码实现", (lite["mode"], lite["stage"]), ("lite", "build"))
    st, wf = call("GET", f"/api/requirements/{lite['id']}/workflow", {"token": tk})
    check("看板带出 mode", (st, wf["requirement"]["mode"]), (200, "lite"))
    st, bad = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "乱传模式", "mode": "hack"})
    check("非法 mode 回落 full", (st, bad["mode"], bad["stage"]), (200, "full", "clarify"))

    st, agent = call("POST", "/api/agents", {"admin": ADMIN},
                     {"name": "stub", "type": "stub", "config": {}})
    check("建桩 Agent", st, 200)
    st, sess = call("POST", "/api/sessions", {"token": tk}, {"requirement_id": rid})
    check("建会话", st, 200)
    sid = sess["id"]

    # ---------------- 需求澄清 ----------------
    st, out = call("PATCH", f"/api/requirements/{rid}", {"token": tk},
                   {"description": "用户希望免密登录，减少输入密码"})
    check("保存需求文档", (st, out["description"]), (200, "用户希望免密登录，减少输入密码"))

    st, out = call("POST", f"/api/requirements/{rid}/polish", {"token": tk}, {"session_id": sid})
    check("AI 润色返回正文", (st, out["content"].startswith("## 背景"), out["agent"]), (200, True, "stub"))

    st, out = call("GET", f"/api/requirements/{rid}/workflow", {"token": tk})
    check("看板：阶段与文档", (st, out["stage"], out["cases"]["total"]), (200, "clarify", 0))
    check("看板：会话数", len(out["sessions"]), 1)
    check("看板：会话带 agent 名", (out["sessions"][0]["agent"], out["sessions"][0]["messages"]),
          ("stub", 0))
    check("看板：非 git 目录标记改动不可用", out["changes"]["available"], False)

    # ---------------- 用例 CRUD ----------------
    st, c = call("POST", f"/api/requirements/{rid}/cases", {"token": tk},
                 {"title": "手动用例", "steps": "1. 做", "expected": "好"})
    check("新增用例", (st, c["status"], c["source"]), (200, "pending", "manual"))
    cid = c["id"]
    st, _ = call("POST", f"/api/requirements/{rid}/cases", {"token": tk}, {"title": "  "})
    check("空标题 400", st, 400)
    st, _ = call("POST", f"/api/requirements/{rid}/cases", {"token": tk},
                 {"title": "x", "status": "unknown"})
    check("非法状态 400", st, 400)

    st, out = call("PATCH", f"/api/cases/{cid}", {"token": tk}, {"status": "passed", "note": "一次通过"})
    check("勾选验证结果", (st, out["status"], out["note"]), (200, "passed", "一次通过"))

    st, out = call("POST", f"/api/requirements/{rid}/cases/bulk", {"token": tk},
                   {"cases": [{"title": "批量A"}, {"title": ""}, {"title": "批量B"}]})
    check("批量写入跳过空标题", (st, out["created"]), (200, 2))
    check("批量来源标记为 ai", [c["source"] for c in out["cases"]], ["ai", "ai"])

    # ---------------- AI 一键生成用例（走桩 agent 的完整链路） ----------------
    st, out = call("POST", f"/api/requirements/{rid}/cases/generate", {"token": tk},
                   {"session_id": sid, "count": 3})
    check("一键生成用例", (st, out["created"], out["warning"]), (200, 3, ""))
    check("生成结果带步骤与预期", bool(out["cases"][0]["steps"] and out["cases"][0]["expected"]), True)

    st, out = call("GET", f"/api/requirements/{rid}/cases", {"token": tk})
    check("用例列表总数", (st, len(out)), (200, 6))
    st, out = call("GET", f"/api/requirements/{rid}/workflow", {"token": tk})
    check("看板：用例统计", (out["cases"]["total"], out["cases"]["passed"]), (6, 1))

    # ---------------- 从工作区导入用例草稿（对话生成 → cases-draft.md → 导入落库） ----------------
    import os as _os

    st, out = call("GET", f"/api/requirements/{rid}/workflow", {"token": tk})
    dname = out["requirement"]["dir_name"]
    draft_rel = f".janus/{dname}/usecase/cases-draft.md"
    draft_abs = _os.path.join(str(s.ws), *draft_rel.split("/"))
    _os.makedirs(_os.path.dirname(draft_abs), exist_ok=True)
    # 一条与库里同名（generate 已生成「正确的账号密码可登录成功」），一条全新：验证同名跳过
    with open(draft_abs, "w", encoding="utf-8") as f:
        f.write(
            "```json\n"
            '[{"title": "正确的账号密码可登录成功", "steps": "1. 重复导入", "expected": "同名跳过"},\n'
            ' {"title": "从草稿导入的新用例", "steps": "1. 打开工作区\\n2. 点导入", "expected": "落库成功"}]\n'
            "```\n"
        )
    st, out = call("POST", f"/api/requirements/{rid}/cases/import", {"token": tk})
    check("导入草稿：新增 1 条、同名跳过 1 条", (st, out["created"], out["skipped"]), (200, 1, 1))
    check("导入用例标记为 ai", [c["source"] for c in out["cases"]], ["ai"])
    st, out = call("GET", f"/api/requirements/{rid}/cases", {"token": tk})
    check("导入后用例总数", len(out), 7)
    with open(_os.path.join(str(s.ws), ".janus", dname, "usecase", "usercase.md"),
              encoding="utf-8") as f:
        check("导出清单包含导入的用例", "从草稿导入的新用例" in f.read(), True)
    check("导入成功后草稿已删除", _os.path.exists(draft_abs), False)
    st, out = call("POST", f"/api/requirements/{rid}/cases/import", {"token": tk})
    check("草稿不存在 404", (st, "用例草稿" in out["detail"]), (404, True))

    # ---------------- 批量删除 ----------------
    st, all_cases = call("GET", f"/api/requirements/{rid}/cases", {"token": tk})
    pick = [c["id"] for c in all_cases[:2]]
    st, out = call("POST", "/api/cases/batch-delete", {"token": tk}, {"ids": pick})
    check("批量删除 2 条", (st, out["deleted"]), (200, 2))
    st, out = call("GET", f"/api/requirements/{rid}/cases", {"token": tk})
    check("批量删除后总数", (st, len(out)), (200, 5))
    st, out = call("POST", "/api/cases/batch-delete", {"token": tk}, {"ids": [pick[0]]})
    check("含不存在 id 整批拒绝 404", st, 404)
    st, out = call("POST", "/api/cases/batch-delete", {"token": tk}, {"ids": []})
    check("空 ids 400", st, 400)
    st, out = call("GET", f"/api/requirements/{rid}/cases", {"token": tk})
    check("整批拒绝后没有误删", len(out), 5)

    # 草稿不是合法用例 JSON：400 且原文不落库
    st, out = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "草稿格式错误", "description": ""})
    rid5 = out["id"]
    st, out = call("GET", f"/api/requirements/{rid5}/workflow", {"token": tk})
    draft5 = _os.path.join(str(s.ws), ".janus", out["requirement"]["dir_name"],
                           "usecase", "cases-draft.md")
    _os.makedirs(_os.path.dirname(draft5), exist_ok=True)
    with open(draft5, "w", encoding="utf-8") as f:
        f.write("抱歉，我不会用 JSON 表达用例。")
    st, out = call("POST", f"/api/requirements/{rid5}/cases/import", {"token": tk})
    check("草稿解析失败 400", (st, "解析" in out["detail"]), (400, True))
    st, out = call("GET", f"/api/requirements/{rid5}/cases", {"token": tk})
    check("解析失败不落库", len(out), 0)

    # ---------------- 阶段切换与归档 ----------------
    st, out = call("POST", f"/api/requirements/{rid}/stage", {"token": tk}, {"stage": "build"})
    check("切到编码实现", (st, out["stage"]), (200, "build"))
    st, _ = call("POST", f"/api/requirements/{rid}/stage", {"token": tk}, {"stage": "nope"})
    check("非法阶段 400", st, 400)

    st, out = call("POST", f"/api/requirements/{rid}/archive", {"token": tk}, {"verdict": "maybe"})
    check("非法验收结论 400", st, 400)

    st, out = call("POST", f"/api/requirements/{rid}/stage", {"token": tk}, {"stage": "verify"})
    st, out = call("POST", f"/api/requirements/{rid}/archive", {"token": tk},
                   {"verdict": "rejected", "note": "失败用例未处理"})
    check("归档：打回", (st, out["stage"], out["verdict"], bool(out["archived_at"])),
          (200, "archive", "rejected", True))
    st, out = call("GET", f"/api/requirements/{rid}/workflow", {"token": tk})
    check("看板回读结论", (out["verdict"], out["verdict_note"]), ("rejected", "失败用例未处理"))

    st, out = call("POST", f"/api/requirements/{rid}/stage", {"token": tk}, {"stage": "verify"})
    check("离开归档即撤销结论", (out["stage"], out["verdict"], out["archived_at"]), ("verify", "", None))

    # ---------------- 权限 ----------------
    st, _ = call("GET", f"/api/requirements/{rid}/cases", {})
    check("无令牌 401", st, 401)
    st, tok2 = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "other", "disk_path": str(s.tmp)})
    st, other = call("POST", f"/api/projects/{tok2['id']}/issue-token", {"admin": ADMIN},
                     {"project_ids": [tok2["id"]]})
    other_tk = other["token"]
    st, _ = call("GET", f"/api/requirements/{rid}/cases", {"token": other_tk})
    check("越权令牌 403", st, 403)
    st, _ = call("POST", f"/api/requirements/{rid}/cases/generate", {"token": other_tk}, {})
    check("越权生成 403", st, 403)
    st, _ = call("POST", f"/api/requirements/{rid}/cases/import", {"token": other_tk})
    check("越权导入 403", st, 403)
    st, all_cases = call("GET", f"/api/requirements/{rid}/cases", {"token": tk})
    st, _ = call("POST", "/api/cases/batch-delete", {"token": other_tk},
                 {"ids": [c["id"] for c in all_cases[:1]]})
    check("越权批量删除 403", st, 403)
    st, _ = call("DELETE", f"/api/requirements/{rid}", {})
    check("无令牌删需求 401", st, 401)

    # ---------------- 需求文档为空的兜底 ----------------
    st, req2 = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                    {"title": "空文档需求", "description": ""})
    rid2 = req2["id"]
    st, out = call("POST", f"/api/requirements/{rid2}/cases/generate", {"token": tk}, {"session_id": sid})
    check("空需求文档不调模型 400", st, 400)

    # ---------------- 模型答了但解析不出来：不报错，交回原文 ----------------
    st, req3 = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                    {"title": "答非所问", "description": "GARBAGE 需求文档"})
    rid3 = req3["id"]
    st, out = call("POST", f"/api/requirements/{rid3}/cases/generate", {"token": tk}, {"session_id": sid})
    check("解析失败仍 200", (st, out["created"]), (200, 0))
    check("解析失败带 warning 与原文", (bool(out["warning"]), "抱歉" in out["raw"]), (True, True))
    st, out = call("POST", f"/api/requirements/{rid3}/polish", {"token": tk}, {"session_id": sid})
    # 润色只要求「有文本」，模型答非所问也原样透传（前端有预览 + 采纳/放弃，不会直接改库）
    check("润色原样透传模型文本", (st, out["content"].startswith("抱歉"), out["warning"]), (200, True, ""))

    # ---------------- 未指定会话时回退到库里的 agent ----------------
    st, req4 = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                    {"title": "回退取 agent", "description": "免密登录的需求草稿"})
    st, out = call("POST", f"/api/requirements/{req4['id']}/cases/generate", {"token": tk}, {"count": 2})
    check("无会话也能生成", (st, out["created"]), (200, 3))
finally:
    s.stop()

raise SystemExit(s.finish())
