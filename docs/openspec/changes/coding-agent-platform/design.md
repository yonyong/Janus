## Context

作者需要一个本地平台，把 coding agent 的编码能力通过对话下放给业务人员。平台自身为 Web 应用（FastAPI + React），作者本地启动后把带令牌的链接发给业务人员；业务人员进入后只能看到被授权的项目，在「需求设计工作台」里通过对话召唤 coding agent 直接修改映射目录下的项目代码，并以 diff / 测试结果回显，直到满足业务需求。

平台代码放置于本仓库 `coding-agent-platform/` 子目录，由本 change 统一跟踪；目标项目代码位于作者机器上其他目录，平台仅按映射访问，不把平台代码写入目标项目。

## Goals / Non-Goals

**Goals:**
- 四大模块可运行：coding agent 管理、项目管理（磁盘映射 + 令牌授权）、需求管理、需求设计工作台。
- 可插拔执行引擎：统一 provider 接口，本轮实现 CodeBuddy 适配器，架构预留 Cursor 等后续接入。
- 链接令牌免登录：业务人员持令牌仅可见被授权项目，无账号体系。
- 四窗格对话工作台：需求 / 设计 / 编码 / 测试 共享同一条对话主线，编码改动与测试结果实时回显。
- 安全边界：仅允许 agent 读写映射目录（目录白名单）。

**Non-Goals:**
- 不做多租户 / 云端部署、不做账号与细粒度权限体系。
- 本轮不实现除 CodeBuddy 外的第二个 agent 适配器（接口预留）。
- 不做代码托管 / CI；不把平台代码注入目标项目。

## Decisions

**D1 — 技术栈：FastAPI + React(Vite)**
FastAPI 原生异步、对 SSE 流式对话支持好、与 Python 生态（agent 编排、文件操作）契合；React 生态成熟，四窗格 UI 易实现。作者已选定。

**D2 — 分层架构**
- 后端：`API 层`（FastAPI routers）→ `领域服务层`（agent / project / requirement / token 服务）→ `执行引擎`（provider 接口 + 适配器 + registry）→ `存储层`（SQLite via SQLAlchemy）。
- 前端：React Router 页面 + 工作台组件；状态用轻量 store（Zustand/Context）。
- 对话/事件通过 SSE 单向推流（agent 事件 → 编码/测试窗格），业务→平台用普通 POST。

**D3 — 可插拔执行引擎（核心）**
定义抽象接口 `CodingAgentProvider`：`invoke(task, project_path, callbacks) -> AsyncIterator[AgentEvent]`，`AgentEvent` 含 progress / diff / test_result 等类型。
`AgentRegistry` 按 type 注册适配器；工作台只依赖接口，不感知具体 agent。
本轮实现 `CodeBuddyAdapter`（复用你已有的 CodeBuddy 能力）。Cursor 等后续仅需新增一个适配器类。

**D4 — 授权：链接令牌免登录 + 目录白名单**
令牌 = 随机密钥，绑定 `project_ids` 列表，存 DB。前端请求携带令牌（query 或 header），中间件校验后解析可访问项目集合并注入请求作用域。所有 agent 文件操作经平台代理，按 `realpath` 前缀校验路径落在映射目录内，越界拒绝。

**D5 — 四窗格共享会话**
单需求 = 一个 session，含统一 message 流；每 message 带 `pane` 标签（requirement/design/code/test）。四窗格是同一会话在不同视图下的呈现：需求窗格=需求文档，设计窗格=设计说明（手动或对话推导），编码窗格=agent 事件流 + diff，测试窗格=测试结果。

**D6 — 改动与测试回显**
- diff：agent 完成改动后，若目标项目为 git 仓库用 `git diff` 取未提交改动；非 git 则做文件哈希快照对比，结果回填编码窗格。
- 测试：在映射项目目录运行项目预设的测试命令（如 `pytest` / `npm test`），捕获输出回填测试窗格；命令在 project/requirement 配置中指定。

**D7 — 本地启动与分享**
平台监听 `0.0.0.0:PORT`，作者把 `http://<本机IP>:PORT/?token=xxx` 发给业务人员；不做内网穿透（MVP）。

## Risks / Trade-offs

- **[CodeBuddy 调用方式未定]** → 适配器先按「CodeBuddy 暴露 API/SDK」假设实现，保留「子进程调用 CLI」回退；具体契约列为 Open Question，须在 build 前与用户确认。
- **[agent 误改/改坏代码]** → 仅允许映射目录 + 建议目标项目用 git；编码前自动在目标项目创建/切换到工作分支或 `git stash`，便于回滚。
- **[长任务超时/断连]** → SSE 支持重连，任务状态持久化到 session，断线后可恢复进度。
- **[令牌泄露]** → 令牌可吊销、可设过期时间。
- **[测试命令滥用]** → 测试命令仅由作者配置、限定在映射目录内执行，不接收业务人员任意 shell。

## Migration Plan

MVP 以本地进程运行，无需迁移。后续若需账号/云端，可在不破坏 provider 接口与令牌模型的前提下增量追加，不在本轮范围。

## Open Questions

- CodeBuddy 适配器的具体接口契约（API / SDK / CLI）？须在本轮 build 前确认，决定 `CodeBuddyAdapter` 实现方式。
- 测试命令由谁定义、如何隔离与防滥用（作者预设 vs 每需求指定）？
- 「设计」窗格内容来源：对话自动生成 vs 手动编辑（MVP 先支持手动 + 对话追加）。
