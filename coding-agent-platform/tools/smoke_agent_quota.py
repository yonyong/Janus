"""Agent Token 限额 + 拖拽排序的 HTTP 冒烟。

覆盖三条真实链路（单测直调路由函数，绕过了依赖注入与 ?admin= 解析，这里补上）：
1. 限额配置：创建默认 1000 万、0=不限额、PATCH 改限额、负数 400；
2. 排序：/api/agents/reorder 全量顺序提交，越权 401、缺漏/重复 400；
3. 限额生效：真实跑一次探测留下用量 → 用量达标后 available=false，
   建会话时自动跳过超限 Agent、顺位取下一个可用者。

用法：coding-agent-platform/ 下执行
  python tools/smoke_agent_quota.py
"""
import _smoke_common as S

s = S.boot(port=8027, workspace=False)
call, check, ADMIN = s.call, s.check, s.admin

try:
    # ---------------- 限额配置 ----------------
    st, a1 = call("POST", "/api/agents", {"admin": ADMIN},
                  {"name": "agent-a", "type": "fake", "config": {}})
    check("创建 Agent", st, 200)
    check("默认限额 1000 万", a1["token_limit"], 10000000)
    check("初始用量 0", a1["used_tokens"], 0)
    check("初始可用", a1["available"], True)

    st, a2 = call("POST", "/api/agents", {"admin": ADMIN},
                  {"name": "agent-b", "type": "fake", "config": {}, "token_limit": 0})
    check("创建时 0 = 不限额", (st, a2["token_limit"]), (200, 0))

    st, _ = call("POST", "/api/agents", {"admin": ADMIN},
                 {"name": "agent-c", "type": "fake", "config": {}, "token_limit": -1})
    check("负数限额 400", st, 400)

    st, out = call("PATCH", f"/api/agents/{a1['id']}", {"admin": ADMIN},
                   {"token_limit": 5000000})
    check("PATCH 改限额", (st, out["token_limit"]), (200, 5000000))
    st, out = call("PATCH", f"/api/agents/{a1['id']}", {"admin": ADMIN}, {})
    check("空 body 不改限额", out["token_limit"], 5000000)
    st, _ = call("PATCH", f"/api/agents/{a1['id']}", {"admin": ADMIN}, {"token_limit": -3})
    check("PATCH 负数限额 400", st, 400)

    # ---------------- 排序 ----------------
    st, _ = call("POST", "/api/agents/reorder", None, {"ids": [a2["id"], a1["id"]]})
    check("排序无凭证 401", st, 401)
    st, out = call("GET", "/api/agents")
    check("默认按创建顺序", [a["name"] for a in out], ["agent-a", "agent-b"])

    st, _ = call("POST", "/api/agents/reorder", {"admin": ADMIN},
                 {"ids": [a2["id"]]})
    check("缺漏 id 400", st, 400)
    st, _ = call("POST", "/api/agents/reorder", {"admin": ADMIN},
                 {"ids": [a2["id"], a2["id"]]})
    check("重复 id 400", st, 400)
    st, _ = call("POST", "/api/agents/reorder", {"admin": ADMIN},
                 {"ids": [a2["id"], a1["id"]]})
    check("拖拽排序成功", st, 200)
    st, out = call("GET", "/api/agents")
    check("新顺序生效（b 在前）", [a["name"] for a in out], ["agent-b", "agent-a"])

    # ---------------- 限额生效 ----------------
    # 真实跑一次探测（fake 适配器），留痕会带上估算 token 用量
    st, probe = call("POST", f"/api/agents/{a2['id']}/test", {"admin": ADMIN}, {"message": "你好"})
    check("探测通过", (st, probe["ok"]), (200, True))
    st, out = call("GET", "/api/agents")
    b_row = next(a for a in out if a["id"] == a2["id"])
    check("探测后用量 > 0", b_row["used_tokens"] > 0, True)

    st, out = call("PATCH", f"/api/agents/{a2['id']}", {"admin": ADMIN}, {"token_limit": 1})
    check("限额压到 1 后不可用", (st, out["available"]), (200, False))

    # 建会话：b 排在前面但已超限 → 应顺位取 a
    st, proj = call("POST", "/api/projects", {"admin": ADMIN},
                    {"name": "限额冒烟", "disk_path": str(s.ws)})
    pid = proj["id"]
    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN},
                   {"project_ids": [pid]})
    tk = tok["token"]
    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "限额顺位", "description": "x"})
    rid = req["id"]
    st, sess = call("POST", "/api/sessions", {"token": tk}, {"requirement_id": rid})
    check("超限 Agent 被跳过、顺位取下一个", (st, sess["agent_id"]), (200, a1["id"]))

    # 改回不限额后立即恢复可用
    st, out = call("PATCH", f"/api/agents/{a2['id']}", {"admin": ADMIN}, {"token_limit": 0})
    check("改回不限额恢复可用", (st, out["available"]), (200, True))
finally:
    s.stop()

raise SystemExit(s.finish())
