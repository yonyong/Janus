# 项目设置 · 磁盘日志 · 副屏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员可设置项目 `log_dir`；工作台可实时查看磁盘日志（级别/时间戳着色）；工作台可多开副屏（钉住/弹出，左右各一业务 tab）。

**Architecture:** 在现有 projects 模型上加 `log_dir`；新增只读 log-files API（list/content/SSE）；工作台 rail 增加日志面板；副屏为前端状态 + 同域路由复用 pane，无后端表。

**Tech Stack:** FastAPI · SQLite · React 18 · Ant Design · EventSource SSE

**Spec:** `docs/superpowers/specs/2026-09-22-project-settings-logs-aux-screens-design.md`

## Global Constraints

- `log_dir` 必须是项目 `disk_path` 下已存在子目录；一律 `realpath` 前缀校验。
- 日志渲染仅级别 + 时间戳，不做 ANSI / JSON pretty。
- 副屏不含 Agent 对话；状态以前端为主。
- 不替换 `/logs`（logbus）页面。

## File Map

| 文件 | 职责 |
|---|---|
| `backend/db.py` | `projects.log_dir` SCHEMA + migration |
| `backend/models.py` | ProjectCreate/Update 增加 `log_dir` |
| `backend/repositories.py` | ProjectRepo.create/update 支持 `log_dir` |
| `backend/project_logs.py` | 新建：解析 log_dir、列文件、读增量、SSE 轮询 |
| `backend/app.py` | PATCH 扩展 + log-files 三路由 |
| `backend/tests/test_project_logs.py` | 新建：校验与 API 测试 |
| `backend/tests/test_admin_edit.py` | 扩展 log_dir 编辑用例 |
| `web/src/api.ts` | Project 类型、updateProject、log-files API |
| `web/src/components/DirPickerModal.tsx` | 可选 `rootPath`，限制上溯 |
| `web/src/components/FolderPathInput.tsx` | 透传 `rootPath` / `relative` |
| `web/src/pages/ProjectList.tsx` | 设置按钮 + Modal |
| `web/src/pages/AdminConsole.tsx` | 编辑表单补 `log_dir` |
| `web/src/components/LogPane.tsx` | 新建：磁盘日志面板 |
| `web/src/components/logFormat.tsx` | 新建：行级着色 |
| `web/src/components/FileWorkArea.tsx` | Cat `logs` + 渲染 LogPane |
| `web/src/pages/Workbench.tsx` | 副屏按钮、钉住芯片、热键 |
| `web/src/components/AuxScreen*.tsx` | 配置 Modal、钉住窗、弹出页壳 |
| `web/src/App.tsx` | 路由 `/workbench/:sid/aux/:auxId` |
| `web/src/shortcuts.ts` / HelpPanel | 文案同步 |

---

### Task 1: 后端 `log_dir` 字段与项目更新

**Files:** `backend/db.py`, `models.py`, `repositories.py`, `app.py`, `tests/test_admin_edit.py`

- [ ] SCHEMA + `_MIGRATIONS` 增加 `("projects", "log_dir", "TEXT")`
- [ ] `ProjectCreate.log_dir: str | None = None`；`ProjectUpdate.log_dir` 用可选字段（`None`=不改；空串=清空）
- [ ] `ProjectRepo.create/update` 写入 `log_dir`
- [ ] `update_project`：解析相对路径，校验目录在 `disk_path` 内；清空时写 `NULL`
- [ ] 测试：更新/清空/越界/非目录
- [ ] Commit

### Task 2: 磁盘日志 API

**Files:** Create `backend/project_logs.py`；Modify `app.py`；Create `tests/test_project_logs.py`

- [ ] `resolve_log_root(proj) -> abs|None`
- [ ] `list_log_files(root) -> [{path,name,size,mtime}]`（一层；`.log`/`.txt`/无扩展名）
- [ ] `read_log_chunk(root, rel, offset, max_bytes=64KiB) -> {offset,next_offset,content,eof,size}`
- [ ] SSE：每 ~0.6s 读增量；文件消失发 `event: reset`
- [ ] 路由挂 `get_allowed`；路径越界 403
- [ ] 测试覆盖 list/content/越界/未配置
- [ ] Commit

### Task 3: 前端项目设置

**Files:** `api.ts`, `DirPickerModal`, `FolderPathInput`, `ProjectList`, `AdminConsole`

- [ ] `Project.log_dir`；`updateProject` body 含 `log_dir`
- [ ] DirPicker 支持 `rootPath`：禁止上溯出 root；可选把选中绝对路径转为相对
- [ ] ProjectList 管理员「设置」Modal：name / disk_path / log_dir
- [ ] AdminConsole 编辑同步
- [ ] Commit

### Task 4: 工作台日志面板

**Files:** `LogPane.tsx`, `logFormat.tsx`, `FileWorkArea.tsx`, `Workbench` 热键, shortcuts/Help

- [ ] 行渲染：级别色 + 时间戳弱高亮
- [ ] LogPane：下拉、SSE、缓冲 5000 行、自动滚底、未配置提示
- [ ] Cat `logs` 插入脚本与用例之间；Alt+7
- [ ] Commit

### Task 5: 副屏

**Files:** `AuxScreenConfigModal.tsx`, `AuxScreenDock.tsx`, `AuxScreenPage.tsx`, `Workbench.tsx`, `App.tsx`

- [ ] 配置 Modal：left/right tab + docked|popup
- [ ] 钉住：底栏窗 + 最小化芯片列表
- [ ] 弹出：`/#/workbench/:sid/aux/:auxId?...` + sessionStorage
- [ ] 左右复用 pane（抽 `WorkbenchPaneHost` 或直接传 props）
- [ ] Commit

### Task 6: 验证

- [ ] `python backend/tests/run_all.py`
- [ ] `cd web && npm run build`
- [ ] 手动冒烟（设置 → 日志 → 副屏）
- [ ] 更新 PR

---

**执行方式：** 用户已确认「改吧」→ 本会话 Inline Execution，按 Task 1→6 推进。
