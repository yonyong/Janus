"""Pydantic 请求/响应模型。"""
from pydantic import BaseModel


class AgentCreate(BaseModel):
    name: str
    type: str
    config: dict = {}
    # 每日 Token 用量上限：默认 1000 万/天，当日用满即不可用；0 表示不限额
    token_limit: int | None = None


class AgentUpdate(BaseModel):
    """Agent 配置的部分更新：只改显式传入的字段（token_limit 传 0 表示不限额）。"""
    name: str | None = None
    type: str | None = None
    config: dict | None = None
    token_limit: int | None = None


class AgentReorderIn(BaseModel):
    """Agent 拖拽排序：ids 按目标顺序列出全部 Agent 的 id。"""
    ids: list[int] = []


class AgentTestIn(BaseModel):
    """一键测试：默认发「你好」，timeout 为秒。"""
    message: str = "你好"
    timeout: float | None = None


class ProjectCreate(BaseModel):
    name: str
    disk_path: str


class ProjectUpdate(BaseModel):
    """项目信息的部分更新：只改显式传入的字段。"""
    name: str | None = None
    disk_path: str | None = None


class RequirementCreate(BaseModel):
    title: str
    description: str = ""
    # 工作流模式：full 标准四阶段 / lite 轻量（跳过澄清与用例，直接进编码实现）
    mode: str = "full"


class TokenIssue(BaseModel):
    project_ids: list[int]
    ttl_days: int | None = None
    expires_at: str | None = None
    note: str = ""


class AdminTokenIssue(BaseModel):
    """管理台签发令牌：project_ids 为空表示授权全部项目。

    有效期二选一：ttl_days（1/3/7 天）或 expires_at（ISO 时间串，指定日期时刻）；
    两者都为空表示永不过期。
    """
    project_ids: list[int] = []
    ttl_days: int | None = None
    expires_at: str | None = None
    note: str = ""


class AdminTokenUpdate(BaseModel):
    """令牌的部分更新：只有显式传入的字段才会被修改。"""
    note: str | None = None
    expires_at: str | None = None
    ttl_days: int | None = None
    never_expires: bool = False


class MessageIn(BaseModel):
    message: str


# ---------------- 工作台文件面板 ----------------

class FileWriteIn(BaseModel):
    """保存文件内容：path 为项目内相对路径，不存在则新建。"""
    path: str
    content: str = ""


class FileCreateIn(BaseModel):
    """新建文件或目录：type 取 file / dir，path 为项目内相对路径。"""
    path: str
    type: str = "file"


class FileRenameIn(BaseModel):
    """同级重命名：new_name 只允许单层名称。"""
    path: str
    new_name: str


# ---------------- 工作流（需求澄清 → 编码实现 → 功能验证 → 归档验收） ----------------

# 阶段与验收结论的合法取值（前端下拉/步骤条与之保持一致）
STAGES = ("clarify", "build", "verify", "archive")
CASE_STATUSES = ("pending", "passed", "failed", "skipped")
VERDICTS = ("accepted", "rejected")


class RequirementUpdate(BaseModel):
    """需求文档 / 阶段的部分更新：只改显式传入的字段。"""
    title: str | None = None
    description: str | None = None
    # 详细设计文档（Agent 分析生成或用户手写）；与原始需求 description 分开存
    design_doc: str | None = None
    stage: str | None = None
    # 本次修改的来源，只用于版本历史打标：manual 手动保存 / ai 采纳了润色结果
    source: str | None = None


class StageIn(BaseModel):
    stage: str


class CaseIn(BaseModel):
    title: str
    steps: str = ""
    expected: str = ""
    status: str = "pending"
    note: str = ""
    # 来源留空由接口决定：单条新增=manual，批量写入（AI 生成）=ai
    source: str | None = None


class CaseBulkIn(BaseModel):
    """批量写入用例（AI 生成后由用户确认再提交）。"""
    cases: list[CaseIn] = []


class CaseBatchDeleteIn(BaseModel):
    """批量删除用例：ids 必须非空且不重复。"""
    ids: list[int] = []


class CaseUpdate(BaseModel):
    title: str | None = None
    steps: str | None = None
    expected: str | None = None
    status: str | None = None
    note: str | None = None


class ArchiveIn(BaseModel):
    """归档验收结论：accepted 通过 / rejected 打回，note 为验收备注。"""
    verdict: str
    note: str = ""


class AiTaskIn(BaseModel):
    """AI 任务参数：session_id 用于沿用该会话的 agent，count 为期望用例条数。

    doc / title 允许前端直传编辑框里的当前内容：需求文档可能还没保存，
    库里的 description 是旧的（甚至为空），润色必须针对用户眼前这份来。
    """
    session_id: int | None = None
    count: int = 6
    timeout: float | None = None
    doc: str | None = None
    title: str | None = None
