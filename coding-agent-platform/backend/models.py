"""Pydantic 请求/响应模型。"""
from pydantic import BaseModel


class AgentCreate(BaseModel):
    name: str
    type: str
    config: dict = {}


class ProjectCreate(BaseModel):
    name: str
    disk_path: str


class RequirementCreate(BaseModel):
    title: str
    description: str = ""


class TokenIssue(BaseModel):
    project_ids: list[int]
    ttl_days: int | None = None


class MessageIn(BaseModel):
    message: str
