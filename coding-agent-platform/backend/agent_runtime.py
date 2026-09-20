"""Coding Agent Provider 协议、事件与注册表。"""
import json
from dataclasses import dataclass
from typing import AsyncIterator, Protocol, runtime_checkable


@dataclass
class AgentEvent:
    type: str  # message | edit | test | status | error
    pane: str = "message"
    text: str | None = None
    payload: dict | None = None

    def to_json(self) -> str:
        return json.dumps(
            {"type": self.type, "pane": self.pane, "text": self.text, "payload": self.payload},
            ensure_ascii=False,
        )


@runtime_checkable
class CodingAgentProvider(Protocol):
    async def invoke(
        self, session, message: str, project_path: str, resume_id: str | None = None
    ) -> AsyncIterator[AgentEvent]:
        """执行一次 agent 运行并产出事件流。

        resume_id 为该平台会话上底层 CLI 首轮返回的外部会话 id：非空时适配器应以
        ``--resume``（或等价子命令）续聊，而不是重新开一个会话。适配器发现新的外部
        会话 id 时，应产出 ``AgentEvent(type="session", payload={"cli_session_id": id})``，
        由 session_service 持久化到 sessions 表。
        """
        ...


class AgentRegistry:
    _registry: dict[str, CodingAgentProvider] = {}

    @classmethod
    def register(cls, type_: str, provider: CodingAgentProvider) -> None:
        cls._registry[type_] = provider

    @classmethod
    def get(cls, type_: str) -> CodingAgentProvider:
        if type_ not in cls._registry:
            raise KeyError(f"未注册 agent 类型: {type_}")
        return cls._registry[type_]

    @classmethod
    def registered(cls):
        return list(cls._registry.keys())
