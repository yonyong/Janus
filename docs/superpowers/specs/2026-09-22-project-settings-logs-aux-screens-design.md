---
role: technical-design
status: final
topic: project-settings-logs-aux-screens
---

# 项目设置 · 磁盘日志面板 · 工作台副屏 — 设计 Spec

## 背景与目标

在 Janus 工作台与项目管理上增加三类能力：

1. **项目设置（仅管理员）**：编辑项目基本信息，并指定项目磁盘下的日志目录。
2. **工作台日志面板**：在已配置的日志目录中下拉选择日志文件，实时查看，并对级别/时间戳做格式着色。
3. **工作台副屏**：可多次创建；每次配置左右各一个业务 tab；可钉在工作台或弹出新标签页，可最小化后随时唤出。

**非目标：**

- 不替换、不合并现有平台内存运行日志（`logbus` + `/logs` 页）。
- 不做 ANSI 转义渲染，不做 JSON pretty-print。
- 副屏不含右侧 Agent 对话；不新增后端副屏持久化表。
- 不引入 OS inotify 专用服务；文件增量以 SSE 轮询/读尾为主。

## 决策摘要

| 项 | 选择 |
|---|---|
| 总体路径 | 方案 1：最小增量，复用 Workbench / DirPicker / SSE 鉴权模式 |
| 日志目录 | 相对 `disk_path` 的子目录，管理员用目录选择器指定，前缀校验 |
| 日志渲染 | 级别关键字着色 + 时间戳弱高亮（方案 A） |
| 副屏交互 | 每次点按钮先弹配置 Modal，再生成实例（方案 A） |
| 副屏状态 | 前端 `auxId` + `sessionStorage` / URL query，无后端表 |

## 1. 数据模型与项目设置

### 1.1 Schema

`projects` 表新增可空列：

| Column | Type | 含义 |
|---|---|---|
| `log_dir` | `TEXT` NULL | 相对项目 `disk_path` 的子目录，如 `logs`、`var/log`；空表示未配置 |

- `db.py` SCHEMA + `_MIGRATIONS` 幂等加列。
- `ProjectCreate` / `ProjectUpdate` / 列表与详情返回均包含 `log_dir`。
- `ProjectUpdate` 未传 `log_dir` 则不修改；显式传 `null` 或 `""` 可清空。

### 1.2 校验

写入或解析日志路径时：

1. `root = realpath(disk_path)` 必须为已存在目录。
2. `abs = realpath(root / log_dir)`（`log_dir` 为空则跳过）。
3. `abs` 必须仍以 `root` 为前缀，且为已存在目录；否则 HTTP 400。
4. 日志文件路径同理：必须落在 `realpath(root / log_dir)` 前缀内，禁止 `..` 穿越。

### 1.3 设置 UI（仅管理员）

- 项目列表（及必要时管理台）增加「设置」按钮，仅 `isAdmin` 可见。
- Modal 字段：`name`、`disk_path`、`log_dir`。
- `log_dir` 使用现有 `DirPickerModal` / `FolderPathInput`，浏览根限制在该项目当前 `disk_path` 下；存储仍为相对路径。
- 提交：`PATCH /api/projects/{pid}`（已有 `require_admin`），body 增加可选 `log_dir`。

### 1.4 日志只读 API（有项目访问权即可）

| Method | Route | 说明 |
|---|---|---|
| GET | `/api/projects/{pid}/log-files` | 列出 `log_dir` 下文件；未配置返回空列表 + `log_dir_configured: false` |
| GET | `/api/projects/{pid}/log-files/content?path=&offset=` | 按相对路径读增量；`offset` 为字节偏移；默认从尾部返回最近一段 |
| GET | `/api/projects/{pid}/log-files/stream?path=&after_offset=` | SSE 推送新增字节/行；文件轮转或消失时发控制事件 |

列表规则：

- 只列常规文件；忽略隐藏项（点开头）与子目录（第一期不做递归，或仅一层；若需子路径则 `path` 使用相对 `log_dir` 的相对路径）。
- 优先展示常见后缀 `.log` / `.txt`；无后缀的文本文件可一并列出（按扩展名白名单 + 无扩展名，排除明显二进制扩展名）。

鉴权：与现有项目读接口一致（`get_allowed` / token 或 admin）；SSE 用 query `token`/`admin`。

## 2. 工作台日志面板

### 2.1 入口

- `FileWorkArea` 的 `Cat` 增加 `'logs'`，显示名「日志」。
- 建议 rail 顺序：需求 → Files → 脚本 → **日志** → 用例 → 归档 → 帮助。
- 热键：现有 Alt+1…6 保持；新增「日志」若占用 Alt+7 且无冲突则注册，并同步 `shortcuts.ts` / `HelpPanel`；若冲突则仅 rail 可点。
- `STAGE_CAT` 不默认进入日志。

### 2.2 面板行为

- 未配置 `log_dir`：提示「管理员尚未设置日志目录」；管理员可提供打开项目设置的入口（非管理员只读文案）。
- 顶栏 `Select` 选择日志文件；默认最近 mtime；切换时清空视图，先拉尾部最近 N KB（或约数百行），再挂 SSE。
- 工具条：自动滚底、清屏（仅前端缓冲）、刷新文件列表。
- 前端环形缓冲约最近 5000 行，防止 DOM 过大。
- SSE 断线用 `content?offset=` 续读。

### 2.3 格式渲染（方案 A）

- 按行渲染；匹配常见级别关键字：`DEBUG` / `INFO` / `WARN` / `WARNING` / `ERROR` / `FATAL`（大小写不敏感）并着色。
- 识别行首或常见位置的时间戳（ISO-8601、`YYYY-MM-DD HH:mm:ss` 等）弱高亮。
- 不做 ANSI、不做 JSON pretty。

### 2.4 与 `/logs` 的关系

- 本面板只读磁盘 `log_dir`。
- 平台 `logbus` 内存日志与 `/logs` 页保持独立，职责不合并。

## 3. 工作台副屏

### 3.1 创建

- 工作台顶栏「副屏」按钮（不限管理员）。
- 每次点击弹出配置 Modal：
  - 左侧 tab：需求 / Files / 脚本 / 日志 / 用例 / 归档（单选）
  - 右侧 tab：同上（可与左侧相同）
  - 打开方式：`钉在工作台` | `弹出新标签页`
- 确认后生成一个副屏实例；可重复点击生成多扇。

可选 tab 集合（与主屏业务 pane 对齐，不含帮助、不含 Agent 对话）：

`req` | `code` | `script` | `logs` | `cases` | `arch`

### 3.2 内容与状态

- 左右分栏，各复用现有 pane 组件；会话上下文与主屏相同（`sid` / `pid` / `rid`）。
- 副屏内可再次切换左右 tab，无需回主屏重配。
- 「日志」左右格使用与主屏相同的日志面板实现。
- 实例状态以前端为主：`auxId`、`left`、`right`、`mode`（`docked` | `popup`）；钉住列表可放 React state + `sessionStorage`；弹窗页用 URL：

  `/#/workbench/:sid/aux/:auxId?pid=&rid=&left=&right=`

  配置快照按 `auxId` 写入 `sessionStorage`，刷新可恢复。

### 3.3 钉在工作台

- 底栏或浮动窗，可调高度；支持最小化成芯片（文案如「副屏1 · Files | 日志」）。
- 点击芯片唤出；关闭销毁该实例。
- 多扇钉住时以芯片列表区分。

### 3.4 弹出新标签页

- `window.open` 同域上述路由；鉴权与主工作台相同。
- 主屏卸载不强制关闭已打开的弹出页。
- 弹出页可关闭；第一期可不做「改钉回工作台」回写主屏（若实现成本低可作为增强，非必须）。

### 3.5 限制

- 不新增后端副屏表。
- 文件/日志类请求仍走现有鉴权与路径前缀校验。

## 4. 主要改动面

| 区域 | 文件（预期） |
|---|---|
| DB / models / repo | `backend/db.py`, `models.py`, `repositories.py` |
| API | `backend/app.py`（项目 PATCH 扩展 + log-files 三路由） |
| 前端 API | `web/src/api.ts` |
| 项目设置 | `ProjectList.tsx`（及必要时 `AdminConsole.tsx`） |
| 日志面板 | 新组件如 `LogPane.tsx`；`FileWorkArea.tsx` / `Workbench.tsx` |
| 副屏 | 新组件如 `AuxScreen*.tsx`；`App.tsx` 路由；`Workbench.tsx` 顶栏 |
| 文案/快捷键 | `shortcuts.ts`, `HelpPanel` |

## 5. 测试与验收

- 后端：`log_dir` 迁移与校验（越界、非目录、清空）；list/content/stream 鉴权与路径安全；未配置时的空列表行为。
- 前端构建：`npm run build`。
- 手动/冒烟：管理员设置日志目录 → 工作台日志下拉与实时追加与级别着色；非管理员无设置按钮但仍可读已配置日志；副屏配置 → 钉住最小化/唤出 → 弹出多标签 → 左右 tab 可重复选择。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 大日志撑爆浏览器 | 尾部窗口 + 前端环形缓冲 |
| 路径穿越 | 一律 `realpath` 前缀校验 |
| 副屏多开状态丢失 | `sessionStorage` + URL；钉住态主屏 state |
| 与 logbus 用户混淆 | UI 文案明确「项目磁盘日志」；保留独立 `/logs` |
