# Comet Design Handoff

- Change: coding-agent-platform
- Phase: design
- Mode: compact
- Context hash: 7b1e1166576d7d0c03211a99e0ceea6abab2cbaad06959a5fc724742b023e9db

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## docs/openspec/changes/coding-agent-platform/proposal.md

- Source: docs/openspec/changes/coding-agent-platform/proposal.md
- Lines: 1-33
- SHA256: 183a2e32b89686b047680f29f2607dd13ed54bffe100e0815e9ebdf30cf3fdda

```md
## Why

作者（开发者）需要把"编码能力"下放给不懂代码的业务人员：本地启动一个平台，把带令牌的链接发给业务人员；业务人员进入后选择被预授权的项目，通过对话描述需求，平台召唤 coding agent 直接修改对应项目磁盘上的代码，直到满足业务需求。当前缺少一个能把「业务对话 → 授权项目 → 编码 agent → 磁盘代码改动」完整串起来的平台。

## What Changes

- 新建一个本地 Web 平台（Python/FastAPI + React），作者本地启动后可通过链接分享给业务人员。
- 新增 **Coding Agent 管理**：可配置多个 coding agent（CodeBuddy、Cursor 等），架构可插拔，本轮先实现 CodeBuddy 适配器（含执行引擎）。
- 新增 **项目管理**：维护「项目 ↔ 本地磁盘目录」映射，并生成/管理授权访问令牌（链接令牌免登录）。
- 新增 **需求管理**：每个项目下可挂多个需求（新增、查看、编辑、删除）。
- 新增 **需求设计工作台**：点开单个需求进入对话空间，含「需求 / 设计 / 编码 / 测试」四个上下文窗格，业务人员通过对话召唤 coding agent 对映射项目代码执行修改，并实时回显改动与测试结果。
- 访问采用链接令牌免登录：持有有效令牌的业务人员只能看到被授权的项目，无账号体系。

## Capabilities

### New Capabilities

- `coding-agent-management`：coding agent 的注册/配置与可插拔执行引擎（先实现 CodeBuddy 适配器，统一接口便于后续接入 Cursor 等）。
- `project-management`：项目与本地磁盘目录映射，以及基于访问令牌的授权配置（谁持哪个令牌可访问哪些项目）。
- `requirement-management`：项目下需求的新增、查看、编辑、删除。
- `requirement-design-workbench`：单需求的四窗格（需求 / 设计 / 编码 / 测试）对话工作台，召唤 coding agent 改动目标项目代码。

### Modified Capabilities

（本变更为全新能力，无既有 capability 变更）

## Impact

- **后端新增**：FastAPI 服务——平台 API、coding agent 适配器层、项目/需求/令牌存储、对话与会话管理、文件改动回显。
- **前端新增**：React 应用——四大模块页面 + 四窗格对话工作台（流式消息、diff 预览、测试结果展示）。
- **存储新增**：项目 / 需求 / agent 配置 / 访问令牌（MVP 用本地文件或 SQLite，均在平台目录下，不污染目标项目）。
- **外部依赖**：CodeBuddy 等 coding agent 后端的调用接口（本轮确定 CodeBuddy 适配器契约）；前端构建链（Vite 等）。
- **安全边界**：访问令牌签发与校验、项目目录访问白名单（仅允许 agent 读写已映射目录，禁止越权访问其他路径）。

```

## docs/openspec/changes/coding-agent-platform/design.md

- Source: docs/openspec/changes/coding-agent-platform/design.md
- Lines: 1-65
- SHA256: 84459d04934a3bb7059ac8cdcfa2ab139ecd61443763f97b607f0ff4f4458832

```md
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

```

## docs/openspec/changes/coding-agent-platform/tasks.md

- Source: docs/openspec/changes/coding-agent-platform/tasks.md
- Lines: 1-37
- SHA256: 7d29e7c4ad726d0f9be9694513d53d4c367cbc6413082689cca7e874300c2c77

```md
## 1. 脚手架与基础设施

- [ ] 1.1 初始化 `coding-agent-platform/`：FastAPI 后端 + React(Vite) 前端 + 统一启动脚本，验证 `uvicorn` 能启动且前端可访问。
- [ ] 1.2 引入 SQLite + SQLAlchemy，编写数据库初始化脚本，验证 `data/app.db` 生成且表可创建。

## 2. 数据模型与存储

- [ ] 2.1 定义实体模型 Agent / Project / Requirement / Session / Message / Token，验证建表成功。
- [ ] 2.2 实现基础仓储层（CRUD），验证各实体可增删查改。

## 3. Coding Agent 管理（模块 1）

- [ ] 3.1 实现 `CodingAgentProvider` 抽象接口与 `AgentRegistry`，验证可按 type 注册与取用适配器。
- [ ] 3.2 确认 CodeBuddy 调用契约（API / SDK / CLI，按 design D3 预留 CLI 子进程回退）并实现 `CodeBuddyAdapter`，验证能提交任务并收到事件流。
- [ ] 3.3 实现 agent 配置 REST API（注册/列表/删除）+ 重名校验 + 未配置时返回明确错误，验证行为与 `coding-agent-management` spec 场景一致。

## 4. 项目管理（模块 2）

- [ ] 4.1 实现项目 CRUD + 磁盘路径校验（存在且为目录），验证非法路径被拒（`project-management` spec 场景）。
- [ ] 4.2 实现访问令牌签发/校验（令牌绑定 project_ids），验证生成授权链接且越权访问被拒（spec 场景）。
- [ ] 4.3 实现目录白名单中间件（realpath 前缀校验），验证 agent 越界操作被拦截（spec 场景）。

## 5. 需求管理（模块 3）

- [ ] 5.1 实现需求 CRUD + 按项目列出 + 删除级联清理会话，验证 CRUD 与归属（`requirement-management` spec 场景）。

## 6. 需求设计工作台（模块 4）

- [ ] 6.1 实现四窗格工作台 UI（需求/设计/编码/测试）+ 会话/消息模型（pane 标签），验证点开需求进入四窗格且共享同一对话主线。
- [ ] 6.2 实现对话 POST + SSE 流式：业务发消息召唤 agent，编码窗格实时进度；验证未配置 agent 时提示“未配置 coding agent”。
- [ ] 6.3 实现编码改动 diff 回显（git diff / 文件快照对比），验证 agent 完成后编码窗格展示 diff。
- [ ] 6.4 实现测试窗格：运行项目预设测试命令并回显结果，验证通过/失败展示（`requirement-design-workbench` spec 场景）。

## 7. 端到端联调与交付

- [ ] 7.1 串联主链路：作者配置 CodeBuddy + 项目映射 → 生成令牌链接 → 业务人员打开 → 选授权项目 → 对话 → agent 改盘 → diff/测试回显，验证全链路跑通。
- [ ] 7.2 编写本地启动与分享说明（启动命令、链接生成方式），验证按说明可本地启动并分享。

```

## docs/openspec/changes/coding-agent-platform/specs/coding-agent-management/spec.md

- Source: docs/openspec/changes/coding-agent-platform/specs/coding-agent-management/spec.md
- Lines: 1-41
- SHA256: 1622a2fd761a8993bc277e8bdaa845a92cc4eec844989b5c90a9d7eee99d83bd

```md
## Purpose

让平台以可插拔方式登记并调用多个 coding agent（本轮先实现 CodeBuddy），供需求设计工作台召唤其对目标项目代码执行改动。

## ADDED Requirements

### Requirement: 注册 coding agent 配置
平台 SHALL 允许作者注册一个 coding agent，包含唯一名称、类型（如 codebuddy）与连接配置（端点 / 令牌 / 参数）。

#### Scenario: 成功注册
- **WHEN** 作者提交 name=codebuddy、type=codebuddy 及连接配置
- **THEN** 系统保存该 agent 配置并可在列表中查询

#### Scenario: 重名拒绝
- **WHEN** 作者提交一个已存在的 agent name
- **THEN** 系统拒绝并返回名称冲突错误

### Requirement: 可插拔执行引擎
平台 SHALL 通过统一的 provider 接口调用 coding agent，使新增 agent 类型（如 Cursor）时无需改动工作台代码。

#### Scenario: 通过统一接口召唤
- **WHEN** 工作台请求用某 agent 执行编码任务
- **THEN** 平台经 provider 接口把任务交付给对应适配器，工作台不感知具体 agent 类型

### Requirement: CodeBuddy 适配器
平台 SHALL 提供 CodeBuddy 适配器实现 provider 接口，将平台任务转换为 CodeBuddy 调用并回传进度与结果。

#### Scenario: 编码任务流转
- **WHEN** 工作台向 CodeBuddy 适配器提交（项目路径, 需求描述）
- **THEN** 适配器调用 CodeBuddy，并在工作台回显进度与结果

#### Scenario: CLI 子进程调用
- **WHEN** 适配器以子进程方式启动 CodeBuddy CLI 并传入（项目路径, 对话上下文）
- **THEN** 适配器解析 CLI 的 stdout 事件流（message/edit/test/status）并回传平台

### Requirement: 未配置 agent 时明确提示
当没有任何 coding agent 被配置时，平台 SHALL 拒绝工作台的编码请求并给出清晰提示，而非静默失败。

#### Scenario: 无 agent 配置
- **WHEN** 业务人员发起编码但平台未配置任何 agent
- **THEN** 系统提示“未配置 coding agent”并终止该请求

```

## docs/openspec/changes/coding-agent-platform/specs/project-management/spec.md

- Source: docs/openspec/changes/coding-agent-platform/specs/project-management/spec.md
- Lines: 1-34
- SHA256: eff88c53b783838046ff77c64ba7d2311f2eb9b7cb90e119c8f012678b86b26d

```md
## Purpose

维护「项目 ↔ 本地磁盘目录」映射，并通过访问令牌控制业务人员对项目的可访问范围（链接令牌免登录）。

## ADDED Requirements

### Requirement: 项目磁盘映射
平台 SHALL 为每个项目记录名称与对应的本地绝对目录路径，且后续仅允许访问该目录。

#### Scenario: 创建映射
- **WHEN** 作者创建项目并指定本地目录 D:/projects/foo
- **THEN** 系统记录映射，且该项目的所有文件操作限定在此目录内

#### Scenario: 非法路径拒绝
- **WHEN** 作者指定的路径不存在或不是目录
- **THEN** 系统拒绝创建并提示路径无效

### Requirement: 访问令牌授权
平台 SHALL 签发绑定到一组被授权项目的访问令牌；持有有效令牌的业务用户只能看到这些项目。

#### Scenario: 生成授权链接
- **WHEN** 作者为若干项目生成访问令牌
- **THEN** 系统返回含令牌的链接，该令牌仅能访问这些项目

#### Scenario: 越权不可见
- **WHEN** 业务人员持令牌访问其未被授权的项目
- **THEN** 系统拒绝并返回无权限

### Requirement: 目录访问白名单
平台与 coding agent SHALL 仅读写已映射的项目目录，任何越界访问均被拦截。

#### Scenario: 越权路径拦截
- **WHEN** agent 尝试读写映射目录之外的路径
- **THEN** 平台拒绝该操作并记录告警

```

## docs/openspec/changes/coding-agent-platform/specs/requirement-design-workbench/spec.md

- Source: docs/openspec/changes/coding-agent-platform/specs/requirement-design-workbench/spec.md
- Lines: 1-34
- SHA256: 1588fc431701713b52322c17121231827938c8be797c5aab74d9e34d3e583bd7

```md
## Purpose

为单个需求提供「需求 / 设计 / 编码 / 测试」四窗格对话工作台，业务人员通过对话召唤 coding agent 改动目标项目代码并回显结果，直至满足业务需求。

## ADDED Requirements

### Requirement: 四窗格对话空间
平台 SHALL 为单个需求提供含「需求 / 设计 / 编码 / 测试」四个上下文窗格的工作台，四窗格共享同一条对话主线。

#### Scenario: 打开工作台
- **WHEN** 业务人员点开某需求
- **THEN** 进入四窗格工作台，四窗格共享同一对话主线

### Requirement: 召唤 coding agent 编码
平台 SHALL 允许业务人员在对话中触发编码，召唤已配置的 coding agent 对需求所属项目代码执行修改，并把进度流式送入「编码」窗格。

#### Scenario: 发起编码
- **WHEN** 业务人员在对话中描述编码需求并触发编码
- **THEN** 平台调用 coding agent 对映射项目执行改动，编码窗格实时显示进度

### Requirement: 改动与测试回显
平台 SHALL 在「编码」窗格展示代码 diff / 改动，在「测试」窗格展示测试执行结果。

#### Scenario: 回显改动
- **WHEN** coding agent 完成一轮改动
- **THEN** 编码窗格展示 git diff，测试窗格展示由 agent 自行执行并回传的验证结果（通过 / 失败）

#### Scenario: agent 自主判断编码
- **WHEN** 业务发送一条对话消息
- **THEN** 平台将其转发给 coding agent CLI，由 CLI 自主决定是否修改代码，无需显式「编码」按钮

#### Scenario: 迭代至满足
- **WHEN** 测试未通过或业务不满意
- **THEN** 业务可继续对话要求修改，循环直至满足需求

```

## docs/openspec/changes/coding-agent-platform/specs/requirement-management/spec.md

- Source: docs/openspec/changes/coding-agent-platform/specs/requirement-management/spec.md
- Lines: 1-23
- SHA256: 1ce51a5e93229737cda31154993a11eac2b2a1b022faf6b9d4f2b0a6e1122e9a

```md
## Purpose

在项目之下组织需求，作为需求设计工作台的工作单元（一个需求 = 一个对话空间）。

## ADDED Requirements

### Requirement: 需求 CRUD
平台 SHALL 允许作者在项目下新增、查看、编辑、删除需求。

#### Scenario: 创建需求
- **WHEN** 作者在某项目下新建需求并填写标题与描述
- **THEN** 该需求出现在该项目需求列表中

#### Scenario: 删除级联
- **WHEN** 作者删除某需求
- **THEN** 其关联的工作台会话与记录一并清除

### Requirement: 需求归属
每个需求 SHALL 仅归属于一个项目，并可在该项目内被列出。

#### Scenario: 按项目列出
- **WHEN** 查看某项目
- **THEN** 仅展示该项目下的需求

```
