# Brainstorm Summary

- Change: coding-agent-platform
- Date: 2026-09-18

## 确认的技术方案

**执行模型（关键变更）**：平台不实现 agent 推理，定位为「对话中继 + 事件展示层」。
每个业务消息转发给配置好的 coding agent CLI 子进程（先 CodeBuddy），CLI 自主决定改码/跑测试；
平台将 CLI 输出解析为结构化事件，经 SSE 推到前端四窗格。

**Provider 契约**：`CodingAgentProvider.invoke(session, message, project_path) -> AsyncIterator[AgentEvent]`；
`AgentEvent` 按 `type` 区分：`message`(解释文本) / `edit`(文件改动) / `test`(测试输出) / `status`(进度) / `error`。
`CodeBuddyAdapter` = CLI 子进程包装，按约定协议解析 stdout 为上述事件（具体协议在 build 期与 CodeBuddy 联调确定）。

**四窗格事件映射**：
- 需求窗格：需求文档（来自需求管理）+ agent 的 plan 类事件
- 设计窗格：空占位（本轮不做内容）
- 编码窗格：edit 事件 + 平台 `git diff`（映射目录改动的真实 diff）
- 测试窗格：agent 自报的 test 事件（agent 自行跑测试）
- 中央对话：message 事件流

**触发模型（关键变更）**：无显式「编码」按钮；业务每条消息都转发给 agent CLI，由 CLI 自主判断是否改码，平台标记产生了改动的消息。

**安全**：映射目录白名单（realpath 前缀校验）；agent 在目标项目 git 仓库内工作，session 开始时建工作分支，平台用 `git diff` 取改动，便于回滚。

## 关键取舍与风险

- **[CLI 输出解析脆弱]** → 定义严格事件协议（JSON-lines 优先）；非结构化输出做容错解析；build 期与 CodeBuddy 联调确定。
- **[长任务 / 断连]** → SSE 重连 + session 状态持久化 + 心跳。
- **[agent 跑偏、业务难干预]** → 业务可继续对话纠正；session 可重置。
- **[改坏代码]** → 目标项目用 git，session 工作分支隔离，可一键回滚。

## 测试策略

- 单元：provider 接口、event 解析、令牌校验、路径白名单。
- 集成：MVP 先接「假 agent CLI」（echo 结构化事件）打通全链路，再接真实 CodeBuddy CLI。
- 端到端：作者配 CodeBuddy + 项目映射 → 生成令牌链接 → 业务对话 → agent 改盘 → diff/测试回显。

## Spec Patch

- `coding-agent-management`：新增场景「CLI 子进程调用」——明确 `CodeBuddyAdapter` 以子进程方式启动 CLI 并解析事件流。
- `requirement-design-workbench`：
  - 修正测试场景：由 coding agent 自行执行测试并回传结果，平台在测试窗格展示（非平台跑 test_command）。
  - 新增场景「agent 自主判断编码」：业务消息转发后由 CLI 自主决定是否改码。
