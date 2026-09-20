"""Fake agent 适配器：用于集成测试与本地联调，模拟改码 + 跑测试。"""
import os
from backend.agent_runtime import AgentEvent


class FakeAgentAdapter:
    type = "fake"

    async def invoke(self, session, message, project_path, resume_id=None):
        # resume_id 存在表示这是同一会话的续聊；fake 适配器只做展示，不区分处理逻辑。
        note = "fake agent 续聊处理需求" if resume_id else "fake agent 开始处理需求"
        yield AgentEvent(type="status", pane="message", text=note)
        # 首轮产出一个稳定的外部会话 id，供平台持久化并在后续轮次续聊（模拟真实 CLI）
        if not resume_id:
            yield AgentEvent(type="session", pane="message",
                             payload={"cli_session_id": "fake-session-1"})
        target = os.path.join(project_path, "agent_output.txt")
        with open(target, "w", encoding="utf-8") as f:
            f.write(f"# requirement\n{message}\n")
        yield AgentEvent(type="edit", pane="code", text=f"modified {target}",
                         payload={"path": target})
        yield AgentEvent(type="message", pane="message", text=f"已根据需求修改：{message}")
        yield AgentEvent(type="test", pane="test",
                         payload={"cmd": "pytest", "passed": True, "output": "1 passed"})
