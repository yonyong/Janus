---
comet_change: coding-agent-platform
role: technical-design
canonical_spec: openspec
archived-with: 2026-09-18-coding-agent-platform
status: final
---

# 编码 Agent 平台 — 深度技术设计（Design Doc）

> 本文档是 open 阶段 `design.md` 的深度细化（深化而非替代）。最新决策见 `brainstorm-summary.md`。
> 关键修正：平台定位为「对话中继 + 事件展示层」，coding agent 以 CLI 子进程方式接入并自主决定改码/跑测试。

## 1. 执行模型（核心）

平台**不实现 agent 推理能力**，只做三件事：

1. **中继**：把业务人员在工作台发的对话消息，连同（项目路径 + 需求上下文 + 历史）转发给当前选中的 coding agent CLI。
2. **解析**：把 CLI 的 stdout 按协议解析成结构化 `AgentEvent`，经 SSE 推到前端。
3. **呈现**：按事件类型把内容分流到四窗格。

coding agent（先 CodeBuddy）自主决定何时改代码、改哪些文件、是否跑测试——平台不替它判断。
这带来一个干净的职责边界：**平台 = 编排与展示，agent = 推理与执行**。

## 2. 架构图

```
                业务人员浏览器 (持令牌)
                        │  HTTPS
                        ▼
        ┌──────────────────────────────────────────────┐
        │           平台 (FastAPI + React)              │
        │                                                │
        │  ┌─────────────┐   ┌───────────────────────┐  │
        │  │ Token 中间件 │   │ 领域服务               │  │
        │  │ 解析可访问   │   │ agents/projects/       │  │
        │  │ project 集合 │   │ requirements/sessions  │  │
        │  └──────┬──────┘   └───────────┬───────────┘  │
        │         │                      │              │
        │         ▼                      ▼              │
        │  ┌────────────────────────────────────────┐  │
        │  │ AgentRegistry ──> CodingAgentProvider  │  │
        │  │                    (invoke -> AsyncIter)│  │
        │  │                         │               │  │
        │  │                  CodeBuddyAdapter       │  │
        │  │                  (subprocess: codebuddy)│  │
        │  └───────────────┬────────────────────────┘  │
        │                  │ SSE 事件流                  │
        │         ┌────────▼─────────┐                  │
        │         │ 四窗格工作台 UI  │                  │
        │         │ 需求/设计/编码/测试│                 │
        │         └──────────────────┘                  │
        └───────────────────────┬──────────────────────┘
                                 │ 子进程 stdin/stdout
                                 ▼
                   ┌───────────────────────┐
                   │ CodeBuddy CLI (子进程) │
                   │ 自主改码 / 跑测试       │
                   └───────────┬───────────┘
                               │ 读写
                               ▼
                  映射目录: 目标项目 (git 仓库)
```

## 3. 后端组件

- **API 层**（FastAPI routers）
  - `auth`: 令牌签发、校验（中间件注入 `allowed_projects`）。
  - `agents`: agent 注册/列表/删除。
  - `projects`: 项目 CRUD + 磁盘路径校验 + 令牌绑定。
  - `requirements`: 需求 CRUD + 按项目列出 + 删除级联。
  - `sessions` / `chat`: 会话与消息；`POST /sessions/{id}/messages` 触发 agent，返回 SSE 事件流。
- **领域服务层**：上述各模块的纯逻辑，依赖仓储与 provider。
- **执行引擎**：`AgentRegistry` + `CodingAgentProvider` 抽象 + `CodeBuddyAdapter`。
- **存储层**：SQLite（SQLAlchemy），库文件位于平台目录 `coding-agent-platform/data/app.db`，不污染目标项目。
- **文件代理层**：所有 agent 文件操作经平台做 realpath 白名单校验（仅允许映射目录）。

## 4. 数据模型（SQLite 表）

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `agents` | id, name(唯一), type, config(JSON), created_at | agent 注册；type 决定适配器 |
| `projects` | id, name, disk_path(绝对), created_at | 项目↔磁盘映射 |
| `requirements` | id, project_id(FK), title, description, created_at | 需求归属项目 |
| `tokens` | id, token(随机密钥), project_ids(JSON), expires_at(nullable) | 访问令牌绑定项目集合 |
| `sessions` | id, requirement_id(FK), agent_id(FK), project_id(FK), git_branch, created_at | 单需求对话空间 |
| `messages` | id, session_id(FK), role(user/agent), pane, content, has_edit, created_at | 共享对话主线，pane 标签分流 |

## 5. Agent Provider 契约与 CodeBuddy 适配器

```python
class AgentEvent(BaseModel):
    type: Literal["message", "edit", "test", "status", "error"]
    pane: str                 # requirement | design | code | test
    text: str | None = None   # 解释/状态/错误文本
    payload: dict | None = None  # edit: {path,diff}; test: {cmd,output,passed}

class CodingAgentProvider(Protocol):
    def invoke(self, session, message: str, project_path: str) -> AsyncIterator[AgentEvent]: ...
```

`CodeBuddyAdapter` 实现：
- 以子进程启动 `codebuddy`（命令/参数来自 `agents.config`），工作目录 = `project_path`。
- 通过 stdin 传入结构化 prompt（对话历史 + 当前需求 + 项目路径），从 stdout 逐行读取。
- 解析协议：**JSON-lines 优先**（每行一个 `AgentEvent` JSON）；非结构化文本回退为 `message` 事件。
- 事件回流：把 `edit`/`test` 事件透传给 SSE；平台侧再对映射目录跑 `git diff` 补全编码窗格的真实 diff。

> **集成契约待定**：真实 CodeBuddy CLI 的确切命令、stdin 格式、stdout 事件协议，在 build 期（tasks 3.2）与 CodeBuddy 联调敲定。MVP 先以「假 agent CLI」（echo JSON-lines 事件）打通链路。

## 6. 四窗格事件映射

| 窗格 | 内容来源 | 事件 |
|------|---------|------|
| 中央对话 | agent 解释文本 | `message` |
| 需求 | 需求文档（需求管理）+ agent plan | `message`(pane=requirement) |
| 设计 | **空占位**（本轮不做） | — |
| 编码 | 改动文件列表 + `git diff` | `edit` |
| 测试 | agent 自报的测试执行结果 | `test` |

四窗格共享同一条 `session.messages` 主线，每条消息带 `pane` 标签用于视图分流。

## 7. 授权与白名单

- 业务人员访问 `?token=xxx`；中间件校验令牌 → 解析 `allowed_projects` → 注入请求作用域。
- 越权访问项目：返回 403。
- 文件代理层对 agent 产生的任何路径做 `os.path.realpath` 前缀校验，必须落在 `project.disk_path` 内，否则拒绝并记录告警。

## 8. 流式与长任务

- `POST /sessions/{id}/messages` 以 SSE 返回 `AgentEvent` 流；普通 POST 提交、SSE 推送（单向）。
- 断线重连：session 状态持久化，重连后从最后事件 ID 续传；心跳保活。
- agent 进程超时/崩溃：标记 session 异常，允许重置会话。

## 9. 安全与回滚

- 目标项目建议为 git 仓库；session 开始时在映射目录建工作分支（如 `agent/<session_id>`），agent 在其上改动。
- 平台用 `git diff`/`git status` 取改动回显；业务不满意可一键 `git checkout`/删除分支回滚。
- 令牌可吊销、可设过期时间。
- 测试命令由 agent 自行执行且限定在映射目录，平台不接收业务任意 shell。

## 10. 测试策略

1. **单元**：provider 接口与 event 解析；令牌签发/校验；路径白名单前缀校验。
2. **集成**：先用「假 agent CLI」（echo JSON-lines 事件）打通 提交消息→SSE→四窗格回显 全链路；再接真实 CodeBuddy CLI 验证子进程与解析。
3. **端到端**：作者配置 CodeBuddy + 项目映射 → 生成令牌链接 → 业务打开 → 选授权项目 → 对话 → agent 改盘 → diff/测试回显。
4. **安全**：越权项目访问 403；越界路径被拒。

## 11. 与 tasks.md 的对应

本文档覆盖 `tasks.md` 全部 7 组任务的技术决策；其中：
- tasks 3.2（CodeBuddy 适配器契约）为 build 期联调重点；
- tasks 6.4 测试窗格改为展示 agent 自报结果（平台不跑 test_command，项目表无需 `test_command` 字段）；
- tasks 6.1 设计窗格本轮留空占位。

## 12. 遗留/推迟项

- 设计窗格内容生成（手动/自动）— 后续迭代。
- 第二个 agent 适配器（Cursor 等）— 接口已预留，本轮不实现。
- 账号体系、云端部署、内网穿透 — 非目标。
