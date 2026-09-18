"""Agent Provider 测试：fake 适配器产出 edit/test 事件。"""
import asyncio
import tempfile
from backend.agent_runtime import AgentRegistry
from backend.adapters.fake import FakeAgentAdapter


def test_fake_adapter():
    AgentRegistry.register("fake", FakeAgentAdapter())

    async def run():
        d = tempfile.mkdtemp()
        events = [e async for e in FakeAgentAdapter().invoke(None, "把按钮改成红色", d)]
        assert any(e.type == "edit" for e in events)
        assert any(e.type == "test" for e in events)

    asyncio.run(run())
