"""Agent 一键测试（连通性探测）的 HTTP 冒烟：/api/agents/{aid}/test 真实链路。

为什么要有这一层：单测直接调 `probe_agent()` 函数，绕过了 FastAPI 的依赖注入与
查询参数解析——而这个端点恰恰两样都靠（`?admin=` 是查询参数、`_ok=Depends(require_admin)`
是依赖），且它还会真的去拉子进程。历史上这里没有任何 HTTP 覆盖，于是「探测必然超时」
一路走到用户面前才被发现。本脚本用替身适配器覆盖接口层，不消耗模型额度：

- 正常返回：ok=True、reply 来自 message 事件、临时工作目录被回收
- 超时路径：timed_out=True、error 含「调用超时」、耗时被压在上限附近
- 错误路径：agent 产出 error 事件时 ok=False
- 边界：agent 不存在 404、未注册类型、无凭证 401、正文缺省值

真实 CLI 需要显式开启（会消耗额度、约 15s）：
  CAP_SMOKE_REAL_AGENT=1 python tools/smoke_agent_probe.py

注意：真实 CLI 在 Windows 上会调用 `reg.exe`，若在受限沙箱（如宿主 Agent 的前台执行环境）
里跑会被安全策略拦下。这种情况改用已在运行的后端验证（见 tools/smoke_agent_probe.py 同级
的 HTTP 路径），或在普通终端里执行。

用法：coding-agent-platform/ 下执行
  python tools/smoke_agent_probe.py
"""
import asyncio
import os

import _smoke_common as S

from backend.agent_runtime import AgentEvent


class OkAdapter:
    """正常回一条 message。"""
    type = "smoke-ok"

    async def invoke(self, agent_row, message, project_path):
        yield AgentEvent(type="message", pane="message", text=f"收到：{message}")


class HangAdapter:
    """永不返回：用于验证超时路径与临时目录回收。"""
    type = "smoke-hang"

    async def invoke(self, agent_row, message, project_path):
        await asyncio.sleep(3600)
        yield AgentEvent(type="message", pane="message", text="不该出现")


class BrokenAdapter:
    type = "smoke-broken"

    async def invoke(self, agent_row, message, project_path):
        yield AgentEvent(type="error", pane="message", text="连接被拒绝")


class UsageAdapter:
    """模拟 CLI JSON 结果适配器：message 事件 payload 带回真实 token 用量。"""
    type = "smoke-usage"

    async def invoke(self, agent_row, message, project_path):
        yield AgentEvent(type="message", pane="message", text="用量已回传",
                         payload={"usage": {"prompt_tokens": 120, "completion_tokens": 80,
                                            "total_tokens": 200}})


s = S.boot(port=8024)
call, check, ADMIN = s.call, s.check, s.admin

try:
    for adapter in (OkAdapter(), HangAdapter(), BrokenAdapter(), UsageAdapter()):
        s.register_adapter(adapter)

    def mk_agent(name, type_):
        st, ag = call("POST", "/api/agents", {"admin": ADMIN},
                      {"name": name, "type": type_, "config": {}})
        assert st == 200, (st, ag)
        return ag["id"]

    ok_id = mk_agent("probe-ok", "smoke-ok")
    hang_id = mk_agent("probe-hang", "smoke-hang")
    broken_id = mk_agent("probe-broken", "smoke-broken")
    nogood_id = mk_agent("probe-nogood", "not-registered")
    usage_id = mk_agent("probe-usage", "smoke-usage")

    # ---------------- 正常返回 ----------------
    st, out = call("POST", f"/api/agents/{ok_id}/test", {"admin": ADMIN},
                   {"message": "你好", "timeout": 10})
    check("正常探测 200", st, 200)
    check("ok=True", out["ok"], True)
    check("timed_out=False", out["timed_out"], False)
    check("reply 取自 message 事件", out["reply"], "收到：你好")
    check("error 为空", out["error"], None)
    check("事件数", len(out["events"]), 1)
    check("回显探测消息", out["message"], "你好")

    # 正文缺省：不传 body 时用默认「你好」
    st, out = call("POST", f"/api/agents/{ok_id}/test", {"admin": ADMIN}, None)
    check("缺省 body 仍可用", (st, out["ok"], out["message"]), (200, True, "你好"))

    # 临时工作目录必须被回收（历史故障：孤儿进程占住目录导致越堆越多）
    st, out = call("POST", f"/api/agents/{ok_id}/test", {"admin": ADMIN}, {"timeout": 10})
    wd = out["workdir"]
    check("返回了工作目录", bool(wd), True)
    check("工作目录已回收", os.path.exists(wd), False)

    # ---------------- 超时路径 ----------------
    st, out = call("POST", f"/api/agents/{hang_id}/test", {"admin": ADMIN},
                   {"timeout": 2})
    check("超时探测仍 200", st, 200)
    check("timed_out=True", out["timed_out"], True)
    check("ok=False", out["ok"], False)
    check("error 提示超时", "调用超时" in (out["error"] or ""), True)
    check("耗时受 timeout 约束", out["elapsed_ms"] < 8000, True)
    check("超时后工作目录仍被回收", os.path.exists(out["workdir"]), False)

    # ---------------- 错误路径 ----------------
    st, out = call("POST", f"/api/agents/{broken_id}/test", {"admin": ADMIN}, {"timeout": 10})
    check("error 事件 -> ok=False", (st, out["ok"]), (200, False))
    check("冒泡 error 文本", out["error"], "连接被拒绝")

    # ---------------- 真实用量走 HTTP 链路落库（tokens_estimated=0，不再是估算值） ----------------
    st, out = call("POST", f"/api/agents/{usage_id}/test", {"admin": ADMIN}, {"timeout": 10})
    check("用量探测 ok", (st, out["ok"]), (200, True))
    check("探测结果带 usage", out["usage"],
          {"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200})
    st, rows = call("GET", "/api/admin/invocations",
                    {"admin": ADMIN, "agent_id": usage_id, "limit": 1})
    check("留痕列表 200", st, 200)
    check("留痕有一条", rows["total"], 1)
    row = rows["items"][0]
    check("真实用量不标估算", row["tokens_estimated"], 0)
    check("留痕 token 三元组", (row["prompt_tokens"], row["completion_tokens"], row["total_tokens"]),
          (120, 80, 200))

    # ---------------- 边界 ----------------
    st, out = call("POST", f"/api/agents/{nogood_id}/test", {"admin": ADMIN}, {"timeout": 5})
    check("未注册类型不 500", (st, out["ok"]), (200, False))
    check("未注册类型给出提示", "未注册的 agent 类型" in (out["error"] or ""), True)

    st, _ = call("POST", "/api/agents/99999/test", {"admin": ADMIN}, {"timeout": 5})
    check("agent 不存在 404", st, 404)
    st, _ = call("POST", f"/api/agents/{ok_id}/test", None, {"timeout": 5})
    check("无凭证 401", st, 401)
    st, _ = call("POST", f"/api/agents/{ok_id}/test", {"admin": "wrong"}, {"timeout": 5})
    check("错口令 401", st, 401)

    # ---------------- 可选：真实 CLI 端到端（默认跳过） ----------------
    if os.environ.get("CAP_SMOKE_REAL_AGENT") == "1":
        real_id = mk_agent("probe-real", "codebuddy")
        st, out = call("POST", f"/api/agents/{real_id}/test", {"admin": ADMIN},
                       {"message": "你好", "timeout": 60})
        check("真实 CLI 探测 ok", (st, out["ok"]), (200, True))
        check("真实 CLI 未超时", out["timed_out"], False)
        print(f"    真实探测耗时 {out['elapsed_ms']}ms，reply={out.get('reply')!r}")
        check("真实探测回收到临时目录", os.path.exists(out["workdir"] or "x"), False)
    else:
        print("SKIP  真实 CLI 端到端（设 CAP_SMOKE_REAL_AGENT=1 开启）")
finally:
    s.stop()

raise SystemExit(s.finish())
