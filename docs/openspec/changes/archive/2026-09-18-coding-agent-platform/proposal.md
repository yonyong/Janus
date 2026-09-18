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
