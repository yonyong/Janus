"""会话事件流「刷新续传」的 HTTP 冒烟：/api/sessions/{sid}/active-run + /events 重连语义。

为什么要有这一层：页面刷新会销毁 SSE 连接，但后台 run 继续跑。修复前的行为是
前端刷新后不再订阅，流式输出凭空消失；修复后前端挂载时先问 active-run，
仍在跑就拿着原始 message 重新订阅 /events（同一消息幂等续传）。这个链路里
「断开连接不杀 run」「重连不重复调 agent」「缓冲区从 0 完整回放」三个保证
只有走真实 HTTP + SSE 才验得到，单测直调路由绕过了 StreamingResponse。

用慢速桩适配器模拟流式输出，确定性验证：

- 空闲时 active-run 返回 active=False
- 读到一半断开连接（模拟刷新/断网），run 仍在后台，active-run 返回原始 message
- 用同一 message 重连续读到底：缓冲区完整回放（含已产出的 delta），agent 只调一次
- 跑完后 active-run 恢复 active=False；再连同消息走 DB 回放（不重复落库）
- 真中止：SSE 保持打开时调 /abort，订阅者收到 abort 事件，run 结束不落 agent 消息，
  重发同一消息会新建 run（不是回放半截输出）
- 边界：无凭证 401、会话不存在 404、越权令牌 403

用法：coding-agent-platform/ 下执行
  python tools/smoke_session_events.py
"""
import asyncio
import json
import threading
import time
import urllib.parse
import urllib.request

import _smoke_common as S

from backend.agent_runtime import AgentEvent

MSG = "请润色需求文档"


def _read_all(url, out, stop_evt, max_seconds=30):
    """在后台线程把一条 SSE 读到底（读到 done / error 为止），事件追加进 out。"""
    try:
        with urllib.request.urlopen(url, timeout=max_seconds) as r:
            for raw in r:
                line = raw.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                try:
                    d = json.loads(line[6:])
                except Exception:  # noqa: BLE001
                    continue
                out.append(d)
                if d.get("type") in ("done", "error"):
                    break
    except Exception as e:  # noqa: BLE001
        out.append({"type": "_exc", "text": str(e)})
    finally:
        stop_evt.set()


class SlowAdapter:
    """慢速桩 agent：分两段吐 delta，中间停顿，留出「读到一半断开」的时间窗。"""

    type = "slow-stub"

    async def invoke(self, agent_row, message, project_path):
        # 与真实适配器（codebuddy）一致：status 带 transient 标记，只推流不落库
        yield AgentEvent(type="status", pane="message", text="slow agent 开始处理",
                         payload={"transient": True})
        yield AgentEvent(type="delta", pane="message", text="第一段")
        await asyncio.sleep(1.2)
        yield AgentEvent(type="delta", pane="message", text="第二段")
        await asyncio.sleep(1.2)
        yield AgentEvent(type="message", pane="message", text="最终答复：第一段第二段")


class AbortableAdapter:
    """长跑桩 agent：吐一个 delta 后长时间挂起，供「真中止」链路打断。"""

    type = "abort-stub"

    async def invoke(self, agent_row, message, project_path):
        yield AgentEvent(type="delta", pane="message", text="开始")
        for _ in range(600):
            await asyncio.sleep(0.5)
        yield AgentEvent(type="message", pane="message", text="不应看到的最终答复")


def read_events_until(url, stop_type, max_seconds=30):
    """打开 SSE 读事件，遇到指定类型即断开连接并返回已读事件（模拟浏览器关闭页面）。"""
    events = []
    deadline = time.time() + max_seconds
    with urllib.request.urlopen(url, timeout=max_seconds) as r:
        for raw in r:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            try:
                d = json.loads(line[6:])
            except Exception:  # noqa: BLE001
                continue
            events.append(d)
            if d.get("type") in (stop_type, "done", "error"):
                break
            if time.time() > deadline:
                break
    return events


s = S.boot(port=8026)
s.register_adapter(SlowAdapter())
call, check, ADMIN = s.call, s.check, s.admin

try:
    st, proj = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "stream", "disk_path": str(s.ws)})
    check("创建项目", st, 200)
    pid = proj["id"]
    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN}, {"project_ids": [pid]})
    tk = tok["token"]
    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "流式续传需求", "description": ""})
    check("建需求", st, 200)
    rid = req["id"]
    st, slow_agent = call("POST", "/api/agents", {"admin": ADMIN},
                          {"name": "slow", "type": "slow-stub", "config": {}})
    check("建慢速桩 Agent", st, 200)
    st, sess = call("POST", "/api/sessions", {"token": tk}, {"requirement_id": rid})
    check("建会话", st, 200)
    sid = sess["id"]

    qp = urllib.parse.urlencode({"message": MSG, "token": tk})
    events_url = f"{s.base}/api/sessions/{sid}/events?{qp}"

    # ---------------- 空闲态 ----------------
    st, out = call("GET", f"/api/sessions/{sid}/active-run", {"token": tk})
    check("空闲时 active-run 200", st, 200)
    check("空闲时 active=False", out["active"], False)
    check("空闲时 message 为空", out["message"], None)

    # ---------------- 读到一半断开（模拟页面刷新） ----------------
    first = read_events_until(events_url, "delta")
    check("首连收到首个 delta", [e.get("text") for e in first if e.get("type") == "delta"], ["第一段"])

    time.sleep(0.3)
    st, out = call("GET", f"/api/sessions/{sid}/active-run", {"token": tk})
    check("断开后 run 仍在后台", (st, out["active"]), (200, True))
    check("active-run 带回原始消息", out["message"], MSG)
    check("active-run 带 run_id", isinstance(out["run_id"], str), True)

    # ---------------- 同一 message 重连：续传同一 run，不重复调 agent ----------------
    second = s.stream_run(sid, MSG, token=tk)
    types = [e.get("type") for e in second]
    check("重连收到 done 收尾", types[-1], "done")
    check("重连完整回放已产出的 delta",
          [e.get("text") for e in second if e.get("type") == "delta"], ["第一段", "第二段"])
    finals = [e.get("text") for e in second if e.get("type") == "message"]
    check("重连拿到最终答复", finals, ["最终答复：第一段第二段"])

    time.sleep(0.3)
    st, out = call("GET", f"/api/sessions/{sid}/active-run", {"token": tk})
    check("跑完后 active 恢复 False", (st, out["active"]), (200, False))

    # agent 只调了一次：库里只有一条用户消息
    st, msgs = call("GET", f"/api/sessions/{sid}/messages", {"token": tk})
    check("用户消息不因重连重复落库",
          sum(1 for m in msgs if m["role"] == "user" and m["content"] == MSG), 1)

    # ---------------- 跑完后重连：DB 回放，不重复执行 ----------------
    replay = s.stream_run(sid, MSG, token=tk)
    check("回放路径以 done 收尾", [e.get("type") for e in replay][-1], "done")
    check("回放不含流式 delta", [e for e in replay if e.get("type") == "delta"], [])
    check("回放含最终答复",
          [e.get("text") for e in replay if e.get("type") == "message"], ["最终答复：第一段第二段"])
    st, msgs2 = call("GET", f"/api/sessions/{sid}/messages", {"token": tk})
    check("回放后消息总数不变（用户 1 条 + 最终答复 1 条）", (len(msgs2), len(msgs)), (2, 2))

    # ---------------- 边界与权限 ----------------
    st, _ = call("GET", f"/api/sessions/{sid}/active-run", {})
    check("无凭证 401", st, 401)
    st, _ = call("GET", "/api/sessions/99999/active-run", {"token": tk})
    check("会话不存在 404", st, 404)
    st, p2 = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "other", "disk_path": str(s.tmp)})
    st, t2 = call("POST", f"/api/projects/{p2['id']}/issue-token", {"admin": ADMIN},
                  {"project_ids": [p2["id"]]})
    st, _ = call("GET", f"/api/sessions/{sid}/active-run", {"token": t2["token"]})
    check("越权令牌 403", st, 403)

    # ---------------- 真中止：停止按钮杀掉的是后台 run 本身 ----------------
    # 为什么必须走 HTTP 验证：abort 路由是 async def（task.cancel 必须在事件循环内），
    # 单测直调路由函数绕过了这层约束——如果有人把它改回 def，跨线程 cancel 假中止，
    # 只有真实 HTTP 能暴露。
    s.register_adapter(AbortableAdapter())
    st, ab_agent = call("POST", "/api/agents", {"admin": ADMIN},
                        {"name": "ab", "type": "abort-stub", "config": {}})
    check("建可中止桩 Agent", st, 200)
    # 会话创建时就绑定了「排位最前的可用 Agent」：把 abort-stub 排到最前并新开一个
    # 会话，中止链路才真正跑在长跑桩上（用原会话验不了「长任务被杀」的语义）。
    st, _ = call("POST", "/api/agents/reorder", {"admin": ADMIN},
                 {"ids": [ab_agent["id"], slow_agent["id"]]})
    check("调整 Agent 顺位", st, 200)
    st, sess2 = call("POST", "/api/sessions", {"token": tk}, {"requirement_id": rid})
    check("建中止测试会话", st, 200)
    sid2 = sess2["id"]

    MSG2 = "长任务跑很久"
    qp2 = urllib.parse.urlencode({"message": MSG2, "token": tk})
    events_url2 = f"{s.base}/api/sessions/{sid2}/events?{qp2}"

    st, _ = call("POST", f"/api/sessions/{sid2}/abort", {"token": tk})
    check("空闲时中止返回 aborted=False", (st, _["aborted"]), (200, False))

    # 保持 SSE 打开的同时点中止：abort 事件必须推到仍连接着的订阅者上
    # （这才是前端的真实时序——停止按钮不会先断开对话流）。
    tail = []
    stop_evt = threading.Event()
    reader = threading.Thread(
        target=lambda: _read_all(events_url2, tail, stop_evt), daemon=True)
    reader.start()
    for _ in range(100):
        if any(e.get("type") == "delta" for e in tail):
            break
        time.sleep(0.05)
    check("中止场景订阅者已收到 delta", any(e.get("type") == "delta" for e in tail), True)

    time.sleep(0.2)
    st, out = call("GET", f"/api/sessions/{sid2}/active-run", {"token": tk})
    check("长任务确在后台运行", (st, out["active"]), (200, True))

    st, out = call("POST", f"/api/sessions/{sid2}/abort", {"token": tk})
    check("中止接口返回成功", (st, out["aborted"]), (200, True))
    check("中止接口带回 run_id", isinstance(out["run_id"], str), True)

    reader.join(timeout=10)
    types2 = [e.get("type") for e in tail]
    check("订阅者收到 abort 事件", "abort" in types2, True)
    check("中止后事件流以 done 收尾", types2[-1] if types2 else None, "done")
    check("中止后不应有最终答复", [e for e in tail if e.get("type") == "message"], [])

    time.sleep(0.5)
    st, out = call("GET", f"/api/sessions/{sid2}/active-run", {"token": tk})
    check("中止后 active 恢复 False", (st, out["active"]), (200, False))
    st, msgs3 = call("GET", f"/api/sessions/{sid2}/messages", {"token": tk})
    check("中止的运行不落 agent 消息（半截输出不入对话主线）",
          sum(1 for m in msgs3 if m["role"] == "agent"), 0)

    # 重试语义：被中止的消息重新发送应新建 run（历史里没有完整答复可回放）
    second2 = read_events_until(events_url2, "delta")
    check("重发被中止的消息会新建 run", [e.get("text") for e in second2 if e.get("type") == "delta"],
          ["开始"])
    st, out = call("POST", f"/api/sessions/{sid2}/abort", {"token": tk})
    check("清理重试 run（再中止一次）", (st, out["aborted"]), (200, True))
    time.sleep(0.5)

    # 权限边界：无凭证 / 越权令牌中止一律拒绝
    st, _ = call("POST", f"/api/sessions/{sid2}/abort", {})
    check("中止无凭证 401", st, 401)
    st, _ = call("POST", f"/api/sessions/{sid2}/abort", {"token": t2["token"]})
    check("中止越权令牌 403", st, 403)
finally:
    s.stop()

raise SystemExit(s.finish())
