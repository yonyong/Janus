"""CodeBuddy 适配器：以子进程方式启动 CodeBuddy CLI，解析其 stdout 事件流。

约定（待 build 期与真实 CodeBuddy 联调确认）：
- 通过 stdin 传入 JSON：{"message": ..., "project_path": ...}
- stdout 每行一个 AgentEvent JSON（JSON-lines）；非 JSON 行回退为 message 事件。
"""
import asyncio
import json
from backend.agent_runtime import AgentEvent


class CodeBuddyAdapter:
    type = "codebuddy"

    async def invoke(self, agent_row, message, project_path):
        cfg = json.loads(agent_row["config"]) if isinstance(agent_row, dict) else {}
        cmd = cfg.get("cmd") or "codebuddy"
        args = list(cfg.get("args", []))
        try:
            proc = await asyncio.create_subprocess_exec(
                cmd, *args, cwd=project_path,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            yield AgentEvent(type="error", pane="message",
                             text=f"未找到 CodeBuddy CLI: {cmd}（请在 agent 配置中设置正确的 cmd）")
            return

        prompt = json.dumps({"message": message, "project_path": project_path}, ensure_ascii=False)
        out, _ = await proc.communicate(prompt.encode("utf-8"))
        for line in out.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                yield AgentEvent(
                    type=data.get("type", "message"),
                    pane=data.get("pane", "message"),
                    text=data.get("text"),
                    payload=data.get("payload"),
                )
            except Exception:
                yield AgentEvent(type="message", pane="message", text=line)
