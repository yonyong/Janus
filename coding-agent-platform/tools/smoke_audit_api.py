"""审计接口 HTTP 冒烟：操作日志与 Agent 调用留痕的真实链路。

为什么必须有这一层：单测直接调路由函数，绕过两件事，而这两件恰恰是审计最容易悄悄坏掉的地方：

1. **中间件**。身份（管理员 / 访问令牌 / 匿名）由纯 ASGI 中间件在请求进入时挂到上下文变量上。
   单测里没有中间件，永远是「匿名」，所以「管理员操作被记成 anonymous」这种故障单测验不出来。
2. **依赖注入与查询参数解析**。`?admin=` / `?token=` 是查询参数，路由不显式声明它们，
   全靠中间件读 query string。

脚本用替身适配器模拟模型输出（其中一条还会吐 usage），因此不消耗额度：
- 操作日志：管理员建项目 / 令牌身份写文件 / 失败操作 / 敏感操作（查看令牌原文）
- Agent 留痕：一键测试、工作台会话、AI 生成用例、未注册类型的失败调用
- 查询接口：过滤、分页、统计、facet、详情、权限
- 安全底线：日志里绝不出现令牌明文

用法：coding-agent-platform/ 下执行
  python tools/smoke_audit_api.py
"""
import json

import _smoke_common as S

# 模型输出里带上用量，用来验证「有真实 usage 就不估算」这条分支
REPLY = "已完成需求。\nusage: prompt_tokens: 80, completion_tokens: 40, total_tokens: 120"


class StubAdapter:
    type = "stub"

    async def invoke(self, agent_row, message, project_path):
        from backend.agent_runtime import AgentEvent

        yield AgentEvent(type="status", pane="message", text="stub agent 开始处理")
        yield AgentEvent(type="message", pane="message", text=REPLY)


s = S.boot(port=8026)
s.register_adapter(StubAdapter())
call, check, ADMIN = s.call, s.check, s.admin


def logs(qp=None):
    st, out = call("GET", "/api/admin/audit-logs", {"admin": ADMIN, **(qp or {})})
    assert st == 200, (st, out)
    return out


def invocations(qp=None):
    st, out = call("GET", "/api/admin/invocations", {"admin": ADMIN, **(qp or {})})
    assert st == 200, (st, out)
    return out


try:
    # ---------------- 操作日志：管理员身份 ----------------
    st, proj = call("POST", "/api/projects", {"admin": ADMIN},
                    {"name": "audit-demo", "disk_path": str(s.ws)})
    check("建项目", st, 200)
    pid = proj["id"]

    st, out = call("GET", "/api/admin/audit-logs", {"admin": ADMIN, "action": "project.create"})
    row = out["items"][0]
    check("管理员操作被记为 admin", (st, row["actor_type"], row["actor"]), (200, "admin", "admin"))
    check("记录了来源 IP", bool(row["ip"]), True)
    check("带上了目标对象", (row["target_id"], row["target_name"]), (pid, "audit-demo"))
    check("detail 记录了磁盘路径", json.loads(row["detail"])["disk_path"], str(s.ws))

    # ---------------- 操作日志：令牌身份 + 脱敏 ----------------
    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN},
                   {"project_ids": [pid], "note": "审计冒烟"})
    check("签发令牌", st, 200)
    tk = tok["token"]

    st, _ = call("PUT", f"/api/projects/{pid}/file", {"token": tk},
                 {"path": "audit-note.txt", "content": "hello"})
    check("令牌身份写文件", st, 200)

    out = logs({"action": "file.write"})
    row = out["items"][0]
    check("令牌操作记为 token", (row["actor_type"], row["token_id"] is not None), ("token", True))
    check("令牌已脱敏（不含原文）", tk not in json.dumps(out, ensure_ascii=False), True)
    check("记录了被写文件", (row["target_name"], json.loads(row["detail"])["chars"]), ("audit-note.txt", 5))

    # 敏感操作：查看令牌原文必须留痕，且同样不落明文
    st, listed = call("GET", "/api/admin/tokens", {"admin": ADMIN})
    tid = listed[0]["id"]
    st, revealed = call("GET", f"/api/admin/tokens/{tid}/reveal", {"admin": ADMIN})
    check("查看令牌原文", (st, revealed["token"]), (200, tk))
    out = logs({"action": "token.reveal"})
    check("查看原文被审计", (out["total"], out["items"][0]["target_type"]), (1, "token"))
    check("审计里没有令牌明文", tk not in json.dumps(out, ensure_ascii=False), True)

    # ---------------- 操作日志：失败也要留痕 ----------------
    st, _ = call("POST", "/api/projects", {"admin": ADMIN},
                 {"name": "坏项目", "disk_path": "Z:/根本不存在"})
    check("坏路径建项目 400", st, 400)
    out = logs({"status": "failure"})
    check("失败操作留痕", (out["total"] >= 1, out["items"][0]["status"]), (True, "failure"))
    check("失败原因入库", "磁盘路径不存在" in (out["items"][0]["error"] or ""), True)

    # ---------------- 操作日志：过滤 / 分页 / 统计 / facet ----------------
    check("按分类过滤", logs({"category": "file"})["total"], 1)
    check("关键词过滤", logs({"q": "audit-note"})["total"], 1)
    check("关键词过滤（失败原因）", logs({"q": "磁盘路径"})["total"], 1)
    check("按项目过滤", logs({"project_id": pid})["total"] >= 3, True)
    check("未知过滤字段被忽略", logs({"whatever": "x"})["total"], logs()["total"])

    one = logs({"limit": 2, "offset": 0})
    two = logs({"limit": 2, "offset": 2})
    check("分页 limit 生效", len(one["items"]), 2)
    check("分页不重叠", bool({r["id"] for r in one["items"]} & {r["id"] for r in two["items"]}), False)
    check("total 是过滤后总数", one["total"], logs()["total"])
    check("limit 被夹紧", len(logs({"limit": 100000})["items"]) <= 200, True)

    stats = logs()["stats"]
    check("统计含成功/失败/今日", (stats["success"] >= 1, stats["failure"] >= 1, stats["today"] >= 4),
          (True, True, True))
    fail_stats = logs({"status": "failure"})["stats"]
    check("统计与过滤条件一致", (fail_stats["total"], fail_stats["failure"]), (out["total"], out["total"]))

    facets = logs()["facets"]
    check("facet 有真实分类", any(c["value"] == "project" for c in facets["categories"]), True)
    check("facet 有真实动作", any(a["value"] == "token.reveal" for a in facets["actions"]), True)

    # ---------------- Agent 调用留痕：一键测试 ----------------
    st, agent = call("POST", "/api/agents", {"admin": ADMIN},
                     {"name": "stub", "type": "stub", "config": {"model": "stub-1"}})
    check("建桩 Agent", st, 200)
    aid = agent["id"]

    # 唯一约束冲突是「失败留痕最容易丢」的那一类：路由报错时业务连接仍握着一笔未提交的
    # 写事务（sqlite3 不会因 IntegrityError 自动回滚），审计连接抢不到锁。约定是排队等
    # 请求收尾后补写 —— 这条断言就是在真实 HTTP 链路上守住它（见 backend/audit.py 落库一节）。
    st, _ = call("POST", "/api/agents", {"admin": ADMIN},
                 {"name": "stub", "type": "stub", "config": {}})
    check("重名 Agent 409", st, 409)
    dup = logs({"action": "agent.create", "status": "failure"})
    check("写锁冲突下的失败留痕没被丢掉", dup["total"], 1)
    check("失败留痕带上了原因", "已存在" in (dup["items"][0]["error"] or ""), True)

    st, probe = call("POST", f"/api/agents/{aid}/test", {"admin": ADMIN}, {"timeout": 10})
    check("一键测试成功", (st, probe["ok"]), (200, True))

    st, bad = call("POST", "/api/agents", {"admin": ADMIN},
                   {"name": "nogood", "type": "not-registered", "config": {}})
    st, failed = call("POST", f"/api/agents/{bad['id']}/test", {"admin": ADMIN}, {"timeout": 5})
    check("未注册类型测试失败", failed["ok"], False)

    out = invocations({"source": "probe"})
    check("探测调用留痕两条", out["total"], 2)
    ok_row = [r for r in out["items"] if r["status"] == "success"][0]
    bad_row = [r for r in out["items"] if r["status"] == "error"][0]
    check("成功调用记录了模型", ok_row["model"], "stub-1")
    check("成功调用记录了入参", "你好" in ok_row["prompt_preview"], True)
    check("成功调用记录了出参", "已完成需求" in ok_row["response_preview"], True)
    check("失败调用同样留痕", "未注册的 agent 类型" in (bad_row["error"] or ""), True)
    check("探测操作也进操作日志", logs({"action": "agent.test"})["total"], 2)

    # ---------------- Agent 调用留痕：工作台会话 ----------------
    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "审计需求", "description": "验证会话调用留痕"})
    check("建需求", st, 200)
    rid = req["id"]
    st, sess = call("POST", "/api/sessions", {"token": tk}, {"requirement_id": rid})
    check("建会话", st, 200)
    sid = sess["id"]

    events = s.stream_run(sid, "把首页改一下", token=tk)
    check("会话跑完", any(e.get("type") == "message" for e in events), True)

    out = invocations({"source": "session"})
    check("会话调用留痕一条", out["total"], 1)
    row = out["items"][0]
    check("会话留痕带项目", (row["project_id"], row["project_name"]), (pid, "audit-demo"))
    # 需求标题创建时后端自动加 v-yyyyMMddHHmmss- 前缀
    check("会话留痕带需求",
          (row["requirement_id"], row["requirement_title"].removeprefix("v-").endswith("审计需求")),
          (rid, True))
    check("会话留痕带会话号与触发者", (row["session_id"], row["actor_type"]), (sid, "token"))
    check("会话留痕记录了入参", row["prompt_preview"], "把首页改一下")

    # 详情接口给全文
    st, detail = call("GET", f"/api/admin/invocations/{row['id']}", {"admin": ADMIN})
    check("详情返回完整出参", (st, REPLY in detail["response"]), (200, True))
    check("详情返回完整入参", detail["prompt"], "把首页改一下")
    check("耗时已记录", detail["elapsed_ms"] >= 0, True)

    # ---------------- Agent 调用留痕：AI 生成用例（带真实 usage） ----------------
    st, out = call("POST", f"/api/requirements/{rid}/cases/generate", {"token": tk},
                   {"session_id": sid, "count": 2})
    check("生成用例请求完成", st, 200)
    row = invocations({"source": "ai_cases"})["items"][0]
    check("AI 任务留痕", (row["source"], row["project_id"], row["requirement_id"]),
          ("ai_cases", pid, rid))
    check("识别出真实 token 用量", (row["prompt_tokens"], row["completion_tokens"], row["total_tokens"]),
          (80, 40, 120))
    check("真实用量不标估算", row["tokens_estimated"], 0)

    # ---------------- 调用留痕的过滤 / 统计 ----------------
    check("按状态过滤", invocations({"status": "error"})["total"], 1)
    check("按 Agent 过滤", invocations({"agent_id": aid})["total"], 3)
    check("按会话过滤", invocations({"session_id": sid})["total"], 2)
    check("关键词过滤（出参）", invocations({"q": "已完成需求"})["total"] >= 1, True)
    check("关键词过滤（错误）", invocations({"q": "未注册"})["total"], 1)

    stats = invocations()["stats"]
    check("统计：总数与成败", (stats["total"], stats["success"], stats["error"]), (4, 3, 1))
    # 汇总要与逐条相加一致；三条带 usage 的调用是真实用量，只有那条无输出的失败调用是估算的
    rows = invocations()["items"]
    check("统计：token 汇总与逐条一致", stats["total_tokens"],
          sum((r["total_tokens"] or 0) for r in rows))
    check("统计：只有无输出的失败调用是估算", stats["estimated_rows"], 1)
    check("统计：按来源拆分", stats["by_source"], {"probe": 2, "session": 1, "ai_cases": 1})
    check("统计：平均耗时可用", stats["avg_elapsed_ms"] >= 0, True)
    check("facet 列出 Agent", any(a["id"] == aid for a in invocations()["facets"]["agents"]), True)

    st, _ = call("GET", "/api/admin/invocations/999999", {"admin": ADMIN})
    check("不存在的调用详情 404", st, 404)

    # ---------------- 前端类型契约 ----------------
    # 两个页面的 TS 接口是照着手写字段敲的（web/src/api.ts），这里按同一份字段表核对真实返回，
    # 避免后端改了列名、前端静默显示成空白。
    AUDIT_FIELDS = {"id", "actor_type", "actor", "token_id", "ip", "category", "action",
                    "status", "target_type", "target_id", "target_name", "project_id",
                    "project_name", "detail", "error", "created_at"}
    AUDIT_STATS = {"total", "success", "failure", "today", "projects"}
    INV_FIELDS = {"id", "source", "agent_id", "agent_name", "agent_type", "model",
                  "project_id", "project_name", "requirement_id", "requirement_title",
                  "session_id", "actor_type", "actor", "status", "error", "timed_out",
                  "rate_limited", "prompt_preview", "response_preview", "prompt_chars",
                  "response_chars", "event_count", "elapsed_ms", "prompt_tokens",
                  "completion_tokens", "total_tokens", "tokens_estimated", "created_at"}
    INV_STATS = {"total", "success", "error", "timed_out", "rate_limited", "total_tokens",
                 "prompt_tokens", "completion_tokens", "estimated_rows", "elapsed_ms",
                 "max_elapsed_ms", "avg_elapsed_ms", "by_source"}

    page = logs()
    check("操作日志返回 total/items/stats/facets",
          set(page) >= {"total", "items", "stats", "facets"}, True)
    check("AuditLog 字段齐全", AUDIT_FIELDS - set(page["items"][0]), set())
    check("AuditStats 字段齐全", AUDIT_STATS - set(page["stats"]), set())
    check("facet 项含 value/count",
          set(page["facets"]["categories"][0]) == {"value", "count"}
          and set(page["facets"]["actions"][0]) == {"value", "count"}, True)

    ipage = invocations()
    check("调用留痕返回 total/items/stats/facets",
          set(ipage) >= {"total", "items", "stats", "facets"}, True)
    check("AgentInvocation 字段齐全", INV_FIELDS - set(ipage["items"][0]), set())
    check("InvocationStats 字段齐全", INV_STATS - set(ipage["stats"]), set())
    check("列表不带正文（全文只在详情里）",
          ("prompt" in ipage["items"][0]) or ("response" in ipage["items"][0]), False)
    check("facet 的 Agent 项含 id/name/type",
          set(ipage["facets"]["agents"][0]) >= {"id", "name", "type"}, True)

    # 日期区间过滤：前端只发 YYYY-MM-DD，后端补全当天首尾（否则筛「今天」会漏掉当天记录）
    today = (page["items"][0]["created_at"] or "")[:10]
    check("按单日区间过滤能筛到当天", logs({"start": today, "end": today})["total"], page["total"])

    # ---------------- 权限 ----------------
    st, _ = call("GET", "/api/admin/audit-logs", {})
    check("无口令看操作日志 401", st, 401)
    st, _ = call("GET", "/api/admin/audit-logs", {"token": tk})
    check("仅令牌看操作日志 401", st, 401)
    st, _ = call("GET", "/api/admin/invocations", {"admin": "wrong"})
    check("错口令 401", st, 401)
finally:
    s.stop()

raise SystemExit(s.finish())
