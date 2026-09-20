# 工作台 UX 改造 + CLI 会话续聊 实施计划

对应用户 13 项需求，分为前端体验改造与后端会话续聊两大块。

## 需求映射

| # | 需求 | 归类 |
| --- | --- | --- |
| 1 | Agent 返回内容需要 Markdown 格式化 | 前端·对话 |
| 2 | 返回内容多时输入框被挤下去且无法滚动 | 前端·布局 bug |
| 3 | 工作台支持多主题选择 | 前端·主题 |
| 4 | 项目文件支持按文件名检索 | 前端·文件树 |
| 5 | 流程指令区重新设计为左侧「帮助」侧边 tab（介绍 + 常用指令） | 前端·信息架构 |
| 6 | 流程面板去掉阶段状态 / 推进进度 | 前端·信息架构 |
| 7 | 流程面板更名「帮助面板」，含常用指令 + 介绍 + 快捷键（会话管理/问答/tab 切换等） | 前端·帮助 |
| 8 | 亮/暗模式都要有层次感：背景色与卡片色不能一模一样 | 前端·主题 |
| 9 | 「帮助」菜单排在「归档」「项目文件」之后 | 前端·信息架构 |
| 10 | 帮助面板用横向 tab 切换：入门指引 / 常用指令 / 快捷键 / 常见问题 | 前端·帮助 |
| 11 | 快捷键不与浏览器快捷键冲突 | 前端·快捷键 |
| 12 | 持久化各 CLI 的外部 session_id，后续轮次用 --resume 续聊（不拼 prompt 历史） | 后端·会话 |
| 13 | 对话输入框自动展示常用指令，用户可自选 | 前端·对话 |

## 后端（item 12）

- `sessions` 增列 `cli_session_id TEXT`（db.py SCHEMA + _MIGRATIONS 幂等迁移）。
- `SessionRepo.set_cli_session_id(conn, sid, external_id)` 落库。
- Provider 协议 `invoke` 增加可选 `resume_id=None`；fake 与 CliAgentAdapter 均兼容。
- `_CLI_SPECS` 增加 `resume`（flag / codex 子命令两种模式）：
  - codebuddy / claude / cursor：`--resume <id>`；
  - codex：`codex exec resume <id> ...`。
- CliAgentAdapter 捕获外部 session_id：stream-json 的 `system/init` 与 `result` 事件、
  json 结果对象里的 `session_id`；发现后 `yield AgentEvent(type="session", payload={"cli_session_id": id})`。
- session_service：run 前读 `sess["cli_session_id"]` 作为 resume_id 传入；拦截 `type=="session"`
  事件写库，不落对话、不推前端、不进审计。
- 单测：resume 命令行拼装、session 事件捕获、迁移列存在。

## 前端

### 主题（items 3、8）
- 新增 `ThemeProvider`（context + localStorage 持久化），主题：`light` / `dark` / `slate`(深蓝墨) / `paper`(护眼米)。
- CSS 以 `:root[data-theme=...]` 覆盖设计变量；补齐 `--bg-elevated`（卡片）与 `--bg-page`
  的层次差；把关键硬编码 `#fff` / `#f5f6f7` 收敛到变量。
- antd `ConfigProvider` 按主题切换 `darkAlgorithm` 与 token 映射。
- 顶栏与工作台顶条加入主题切换入口。

### 对话（items 1、2、13）
- item 1：新增 `AgentMarkdown`（复用 marked + DOMPurify + highlight.js），Agent 气泡走 Markdown 渲染；用户气泡保持纯文本。
- item 2：修复 `.chat-pane` 在 `.wb-right` 里的高度链（flex:1 + min-height:0），保证长内容滚动、输入框固定底部。
- item 13：输入框上方常驻「常用指令」快捷条（可折叠），点选填入输入框，用户手动发送。

### 文件检索（item 4）
- FilePane 顶部加搜索框，按文件名过滤已加载节点（匹配命中路径自动展开、高亮）。

### 帮助面板 + 信息架构（items 5、6、7、9、10、11）
- 删除右栏 `FlowCommands`（阶段状态 + 进度），右栏只剩对话。
- FileWorkArea rail 末尾新增「帮助」tab（排在 归档、项目文件 之后 → item 9）。
- 新增 `HelpPanel`：横向 tab（入门指引 / 常用指令 / 快捷键 / 常见问题 → item 10）。
  - 入门指引：工作台四阶段流程简介；
  - 常用指令：原流程指令话术，点选填入输入框（不再显示完成状态/进度）；
  - 快捷键：会话管理、问答管理、tab 切换等，且避开浏览器占用组合（item 11）；
  - 常见问题：FAQ。
- 快捷键统一在 Workbench 注册，使用不与浏览器冲突的组合（如 Alt 系 / 无修饰的输入框内 Enter 等）。

## 验证
- `python backend/tests/run_all.py`（新增 resume/session 单测）+ 冒烟脚本。
- `npm run build` 通过。
- 浏览器走查：主题切换、对话 Markdown、长对话滚动、文件检索、帮助面板四 tab、快捷键、续聊。
