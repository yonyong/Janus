"""Agent 一键测试（连通性探测）测试。"""
import asyncio
import os
import tempfile

import backend.agent_test as at
from backend.agent_runtime import AgentEvent, AgentRegistry
from backend.adapters.fake import FakeAgentAdapter
from backend.agent_test import probe_agent


class SlowAdapter:
    """永不及时返回的 provider，用于验证超时终止。"""

    async def invoke(self, agent_row, message, project_path):
        await asyncio.sleep(5)
        yield AgentEvent(type="message", text="迟到的回复")


class BrokenAdapter:
    async def invoke(self, agent_row, message, project_path):
        yield AgentEvent(type="error", pane="message", text="连接被拒绝")
        raise AssertionError("不应继续执行")


class UsageAdapter:
    """模拟 CLI JSON 结果适配器：message 事件 payload 带回真实 token 用量。"""

    async def invoke(self, agent_row, message, project_path):
        yield AgentEvent(type="message", pane="message", text="完成",
                         payload={"usage": {"prompt_tokens": 120, "completion_tokens": 80,
                                            "total_tokens": 200}})


def _row(type_="fake", **kw):
    row = {"id": 1, "name": "probe-agent", "type": type_, "config": "{}"}
    row.update(kw)
    return row


def test_probe_fake_agent_ok():
    AgentRegistry.register("fake", FakeAgentAdapter())
    r = asyncio.run(probe_agent(_row(), "你好"))
    assert r["ok"] is True, r
    assert r["error"] is None
    assert r["elapsed_ms"] >= 0
    assert any(e["type"] in ("message", "status") for e in r["events"])
    # 临时工作目录用完即清理，不留垃圾
    assert r["workdir"] and not os.path.exists(r["workdir"])


def test_probe_unknown_type():
    r = asyncio.run(probe_agent(_row(type_="nope"), "你好"))
    assert r["ok"] is False
    assert "未注册的 agent 类型" in (r["error"] or "")


def test_probe_timeout():
    AgentRegistry.register("slow", SlowAdapter())
    r = asyncio.run(probe_agent(_row(type_="slow"), "你好", timeout=0.5))
    assert r["ok"] is False
    assert r["timed_out"] is True
    assert "超时" in (r["error"] or "")


def test_probe_error_event():
    AgentRegistry.register("broken", BrokenAdapter())
    r = asyncio.run(probe_agent(_row(type_="broken"), "你好", timeout=5))
    assert r["ok"] is False
    assert "连接被拒绝" in (r["error"] or "")


def test_probe_collects_real_usage_from_payload():
    """适配器在 message 事件 payload 里带回的真实用量要浮到探测结果上（留痕据此免估算）。"""
    AgentRegistry.register("usage", UsageAdapter())
    r = asyncio.run(probe_agent(_row(type_="usage"), "你好", timeout=5))
    assert r["ok"] is True
    assert r["usage"] == {"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200}


def test_rmtree_with_retry_removes_temp_dir():
    d = tempfile.mkdtemp(prefix="cap-agent-probe-test-")
    with open(os.path.join(d, "f.txt"), "w", encoding="utf-8") as f:
        f.write("x")
    asyncio.run(at._rmtree_with_retry(d))
    assert not os.path.exists(d)


def test_rmtree_with_retry_retries_until_success():
    """Windows 上被强杀的子进程会短暂占着目录句柄，首次 rmtree 会静默失败 —— 必须重试。"""
    real = at.shutil.rmtree
    calls = {"n": 0}
    d = tempfile.mkdtemp(prefix="cap-agent-probe-test-")

    def flaky(path, **kw):
        calls["n"] += 1
        if calls["n"] >= 3:
            real(path, **kw)  # 前两次模拟句柄未释放，静默失败

    try:
        at.shutil.rmtree = flaky
        asyncio.run(at._rmtree_with_retry(d, delay=0.01))
        assert calls["n"] == 3, calls
        assert not os.path.exists(d)
    finally:
        at.shutil.rmtree = real
