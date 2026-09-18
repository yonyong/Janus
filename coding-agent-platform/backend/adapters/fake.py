"""Fake agent 适配器：用于集成测试与本地联调，模拟改码 + 跑测试。"""
import os
from backend.agent_runtime import AgentEvent


class FakeAgentAdapter:
    type = "fake"

    async def invoke(self, session, message, project_path):
        yield AgentEvent(type="status", pane="message", text="fake agent 开始处理需求")
        target = os.path.join(project_path, "agent_output.txt")
        with open(target, "w", encoding="utf-8") as f:
            f.write(f"# requirement\n{message}\n")
        yield AgentEvent(type="edit", pane="code", text=f"modified {target}",
                         payload={"path": target})
        yield AgentEvent(type="message", pane="message", text=f"已根据需求修改：{message}")
        yield AgentEvent(type="test", pane="test",
                         payload={"cmd": "pytest", "passed": True, "output": "1 passed"})
