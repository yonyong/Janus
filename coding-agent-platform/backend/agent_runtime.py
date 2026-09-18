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
    async def invoke(self, session, message: str, project_path: str) -> AsyncIterator[AgentEvent]:
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
