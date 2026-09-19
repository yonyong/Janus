"""实时日志接口 HTTP 冒烟：增量拉取 / 过滤 / 权限 / SSE 实时推送 / 平台日志。

为什么要有这一层：单测直接调路由函数，绕过 FastAPI 的依赖注入与查询参数解析 ——
而本模块最容易写漏的恰恰是那两处（SSE 用 ``?token=`` 传令牌、``include_global`` 是
布尔查询参数、pid 白名单校验）。所以这里起真实 uvicorn，走 HTTP 全链路。

覆盖的关键承诺：
  1. 一次 agent 运行结束后，项目日志里能看到会话生命周期与文件改动记录；
  2. 日志按项目隔离：另一个项目的令牌读不到（403），无令牌读不到（401）；
  3. ``after_seq`` 增量语义正确（追平后不再返回旧记录）；
  4. ``level`` / ``source`` 过滤生效；``include_global`` 能把平台级记录带上；
  5. SSE 是**真的实时**：连接建立后新产生的事件能被推送到，而不是只在连上时补发一次；
  6. 令牌无效时 SSE 会给出 error 事件后收尾（不空转重连）。

用法：coding-agent-platform/ 下执行
  python tools/smoke_logs_api.py
"""
import json
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

import _smoke_common as S


class WritingStub:
    """桩 agent：真写一个文件再产出 edit 事件，用来制造「文件改动」这类日志。"""

    type = "writer"

    async def invoke(self, agent_row, message, project_path):
        from backend.agent_runtime import AgentEvent

        (Path(project_path) / "generated.txt").write_text("hello\n", encoding="utf-8")
        yield AgentEvent(type="message", pane="message", text="已生成 generated.txt")
        yield AgentEvent(type="edit", pane="code", text="新增 generated.txt")


def read_stream(url, want, deadline=20.0):
    """把 SSE 读到 want(event) 为真为止；返回收到的事件列表。"""
    got = []
    with urllib.request.urlopen(url, timeout=deadline) as r:
        end = time.time() + deadline
        while time.time() < end:
            raw = r.readline()
            if not raw:
                break
            line = raw.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            try:
                d = json.loads(line[6:])
            except Exception:  # noqa: BLE001
                continue
            got.append(d)
            if want(d):
                break
    return got


s = S.boot(port=8033)
s.register_adapter(WritingStub())
call, check, ADMIN = s.call, s.check, s.admin
BASE = s.base

try:
    # ---------------- 准备：两个项目 + 只授权 A 的令牌 ----------------
    st, pa = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "日志项目A", "disk_path": str(s.ws)})
    check("创建项目 A", st, 200)
    pid = pa["id"]
    ws_b = s.tmp / "ws-b"
    ws_b.mkdir(exist_ok=True)
    st, pb = call("POST", "/api/projects", {"admin": ADMIN},
                  {"name": "日志项目B", "disk_path": str(ws_b)})
    check("创建项目 B", st, 200)
    pid_b = pb["id"]

    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN},
                   {"project_ids": [pid]})
    check("签发只含 A 的令牌", st, 200)
    tk = tok["token"]
    st, tok_b = call("POST", f"/api/projects/{pid_b}/issue-token", {"admin": ADMIN},
                     {"project_ids": [pid_b]})
    tk_b = tok_b["token"]

    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "生成一个文件", "description": "验证实时日志"})
    rid = req["id"]
    st, agent = call("POST", "/api/agents", {"admin": ADMIN},
                     {"name": "writer", "type": "writer", "config": {}})
    check("建桩 Agent", st, 200)
    aid = agent["id"]
    st, sess = call("POST", "/api/sessions", {"token": tk}, {"requirement_id": rid})
    check("建会话", st, 200)
    sid = sess["id"]

    # 全新启动，缓冲里只有上面几次审计动作；先记下当前水位，便于后面断言增量
    st, page = call("GET", f"/api/projects/{pid}/logs", {"token": tk})
    check("日志可读（令牌）", st, 200)
    check("返回缓冲水位字段", (page["capacity"] > 0, page["dropped"], page["truncated"]), (True, False, False))
    check("此前只有审计日志落在项目上",
          sorted({r["source"] for r in page["records"]}), ["audit"])
    before_seq = page["last_seq"]

    # ---------------- 跑一次 agent：会话 + 文件改动都应进入日志 ----------------
    events = s.stream_run(sid, "帮我生成文件", token=tk)
    check("SSE 会话跑完", events[-1].get("type"), "done")

    st, page = call("GET", f"/api/projects/{pid}/logs", {"token": tk})
    check("运行后仍有 200", st, 200)
    recs = page["records"]
    sources = {r["source"] for r in recs}
    check("会话生命周期已入日志", "session" in sources, True)
    check("文件改动已入日志", "files" in sources, True)
    check("记录都归属本项目", {r["project_id"] for r in recs}, {pid})
    check("seq 严格递增", all(b["seq"] > a["seq"] for a, b in zip(recs, recs[1:])), True)
    texts = "\n".join(r["text"] for r in recs)
    check("日志含启动与结束", ("启动 Agent 运行" in texts, "运行结束" in texts), (True, True))
    check("日志含改动统计", "工作区已改动" in texts or "已记录本次改动" in texts, True)
    check("运行日志确实新增了", page["last_seq"] > before_seq, True)

    # ---------------- after_seq 增量语义 ----------------
    st, inc = call("GET", f"/api/projects/{pid}/logs",
                   {"token": tk, "after_seq": page["last_seq"]})
    check("追平后无新记录", (st, inc["records"]), (200, []))
    check("追平后 last_seq 保持不变", inc["last_seq"], page["last_seq"])
    st, back = call("GET", f"/api/projects/{pid}/logs", {"token": tk, "after_seq": 0, "limit": 2})
    check("limit 生效且取最新两条", (len(back["records"]), back["truncated"]), (2, True))

    # ---------------- level / source 过滤 ----------------
    st, only_info = call("GET", f"/api/projects/{pid}/logs", {"token": tk, "level": "info"})
    check("level 过滤只返回 info", {r["level"] for r in only_info["records"]}, {"info"})
    st, only_audit = call("GET", f"/api/projects/{pid}/logs", {"token": tk, "source": "audit"})
    check("source 过滤只返回 audit", {r["source"] for r in only_audit["records"]}, {"audit"})
    st, multi = call("GET", f"/api/projects/{pid}/logs",
                     {"token": tk, "source": "files,session", "level": "info,debug"})
    check("多值过滤取并集", {r["source"] for r in multi["records"]} <= {"files", "session"}, True)

    # ---------------- 平台级日志（一键测试没有项目上下文） ----------------
    st, probe = call("POST", f"/api/agents/{aid}/test", {"admin": ADMIN}, {"message": "你好"})
    check("一键测试通过", (st, probe["ok"]), (200, True))
    st, no_global = call("GET", f"/api/projects/{pid}/logs", {"token": tk, "source": "probe"})
    check("默认不带平台日志", (st, no_global["records"]), (200, []))
    st, with_global = call("GET", f"/api/projects/{pid}/logs",
                           {"token": tk, "source": "probe", "include_global": "true"})
    check("开启后能看到平台日志",
          (st, {r["project_id"] for r in with_global["records"]}), (200, {None}))
    check("平台日志含探测开始与结果",
          any("一键测试开始" in r["text"] for r in with_global["records"]), True)

    # ---------------- 权限：跨项目与无凭证 ----------------
    st, _ = call("GET", f"/api/projects/{pid}/logs", {"token": tk_b})
    check("别的项目令牌读不到（403）", st, 403)
    st, _ = call("GET", f"/api/projects/{pid}/logs", {})
    check("无凭证读不到（401）", st, 401)
    st, _ = call("GET", f"/api/projects/{pid}/logs", {"token": "invalid-token-xxx"})
    check("无效令牌读不到（401）", st, 401)
    st, as_admin = call("GET", f"/api/projects/{pid}/logs", {"admin": ADMIN})
    check("管理员口令可读", st, 200)

    # ---------------- SSE：真·实时推送 ----------------
    # 标记放进新建需求的标题：操作留痕记的是 target_name（标题），这样才能在日志正文里找到它
    # （需求名称创建后不可修改，不能再用 PATCH 标题当触发器）
    marker = f"冒烟标记-{int(time.time())}"

    def trigger():
        time.sleep(0.6)
        call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
             {"title": marker, "description": "SSE 触发用"})

    th = threading.Thread(target=trigger, daemon=True)
    th.start()
    qp = urllib.parse.urlencode({"token": tk, "after_seq": page["last_seq"]})
    got = read_stream(f"{BASE}/api/projects/{pid}/logs/stream?{qp}",
                      lambda d: d.get("type") == "log" and marker in (d["record"]["text"] or ""))
    kinds = [d.get("type") for d in got]
    check("SSE 首帧是 hello", kinds[0] if kinds else None, "hello")
    check("hello 带项目名", got[0].get("project") if got else None, "日志项目A")
    pushed = [d for d in got if d.get("type") == "log"]
    check("SSE 实时推送了新事件", len(pushed) > 0, True)
    check("推送的记录归属正确",
          {d["record"]["project_id"] for d in pushed} if pushed else None, {pid})
    check("推送里含刚触发的操作留痕",
          any(marker in (d["record"]["text"] or "") for d in pushed), True)
    check("推送均为递增 seq",
          all(b["record"]["seq"] > a["record"]["seq"] for a, b in zip(pushed, pushed[1:])), True)
    th.join(timeout=5)

    # 无效令牌：SSE 应给出 error 事件而不是空转
    bad = read_stream(f"{BASE}/api/projects/{pid}/logs/stream?"
                      + urllib.parse.urlencode({"token": "invalid-token-xxx"}),
                      lambda d: d.get("type") == "error", deadline=6)
    check("无凭证 SSE 返回 error 事件", [d.get("type") for d in bad], ["error"])

    # 越权项目：SSE 也应拒绝而不是静默推送别人的日志
    bad2 = read_stream(f"{BASE}/api/projects/{pid}/logs/stream?"
                       + urllib.parse.urlencode({"token": tk_b}),
                       lambda d: d.get("type") == "error", deadline=6)
    check("越权项目 SSE 返回 error 事件", [d.get("type") for d in bad2], ["error"])
finally:
    s.stop()

raise SystemExit(s.finish())
