# 脚本 Tab 与斜杠指令序号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左栏新增「脚本」Tab（`.janus/{dir}/script/` 可参数化脚本 CRUD/执行/日志/AI 协助），侧栏重排并调整 Alt 快捷键；右侧 `/` 常用指令显示序号并支持数字键快选。

**Architecture:** 脚本权威在磁盘；`backend/scripts.py` 负责 frontmatter 解析、列表、保存、临时文件执行、`.runs` 记录；FastAPI 挂在 requirement 下；前端 `ScriptPane` 挂到新 rail cat；`ChatPanel` 斜杠菜单加序号。

**Tech Stack:** FastAPI + SQLite（不存脚本正文）、React 18 + Ant Design、现有 subprocess 执行模式。

**Spec:** `docs/superpowers/specs/2026-09-20-script-tab-and-slash-numbers-design.md`

## Global Constraints

- 参数：YAML frontmatter；执行：CLI `--name value`；boolean 传 `true`/`false` 字符串
- AI 协助：面板按钮灌入对话，不自动发送
- `usecase/accept.*` 验收脚本保持不动
- 脚本扩展名白名单：`.py` `.sh` `.js` `.mjs`；解释器 python3/bash/node
- `{name}` 仅 basename，拒绝路径穿越；输出截断 ~20k；超时 600s；runs 保留 20 条

---

### Task 1: 后端 scripts 模块（路径 + 解析 + CRUD + run）

**Files:**
- Create: `coding-agent-platform/backend/scripts.py`
- Modify: `coding-agent-platform/backend/docs.py`（增加 `script_dir` / `script_file` / `script_runs_file`）
- Test: `coding-agent-platform/backend/tests/test_scripts.py`

**Interfaces:**
- Produces:
  - `WD.script_dir(dir_name) -> str` → `.janus/{dir}/script`
  - `WD.script_file(dir_name, name) -> str`
  - `WD.script_runs_file(dir_name, stem) -> str` → `.janus/{dir}/script/.runs/{stem}.json`
  - `SCR.parse_frontmatter(text) -> (meta: dict, body: str)`
  - `SCR.safe_name(name) -> str`（校验或抛 ValueError）
  - `SCR.list_scripts(root, dir_name) -> list[dict]`
  - `SCR.read_script(root, dir_name, name) -> dict`
  - `SCR.write_script(root, dir_name, name, content) -> dict`
  - `SCR.delete_script(root, dir_name, name) -> None`
  - `SCR.run_script(root, dir_name, name, params: dict) -> dict`（含写入 `.runs`）
  - `SCR.list_runs(root, dir_name, name) -> list[dict]`

- [ ] **Step 1:** 写失败测试（list 空、write+list、非法名、frontmatter、run 传参、last_params、runs 上限）
- [ ] **Step 2:** 实现 `docs.py` 路径助手 + `scripts.py`
- [ ] **Step 3:** `python backend/tests/run_all.py` 全绿
- [ ] **Step 4:** Commit `feat(backend): add parameterized scripts module`

---

### Task 2: FastAPI 路由 + api.ts

**Files:**
- Modify: `coding-agent-platform/backend/app.py`、`coding-agent-platform/backend/models.py`
- Modify: `coding-agent-platform/web/src/api.ts`

**Interfaces:**
- `ScriptSaveIn(content: str)`、`ScriptRunIn(params: dict = {})`
- 路由见 Spec §3

- [ ] **Step 1:** 增加 models + 6 个路由（鉴权同 accept-script）
- [ ] **Step 2:** `api.ts` 类型与客户端函数
- [ ] **Step 3:** 手工或加 HTTP 级单测验证 400 非法名
- [ ] **Step 4:** Commit `feat(api): expose requirement scripts endpoints`

---

### Task 3: 侧栏重排 + ScriptPane

**Files:**
- Create: `coding-agent-platform/web/src/components/ScriptPane.tsx`
- Modify: `FileWorkArea.tsx`、`Workbench.tsx`、`shortcuts.ts`、`HelpPanel.tsx`、`styles.css`、`FlowCommands.tsx`（AI 话术辅助函数）

- [ ] **Step 1:** 更新 Cat / cats 顺序 / Alt 1–6 / 文案
- [ ] **Step 2:** 实现 ScriptPane（列表、参数、编辑、执行、日志、新建、AI 按钮）
- [ ] **Step 3:** 样式与空态
- [ ] **Step 4:** Commit `feat(web): add Scripts rail tab and ScriptPane`

---

### Task 4: 斜杠菜单序号

**Files:**
- Modify: `ChatPanel.tsx`、`HelpPanel.tsx`、`styles.css`

- [ ] **Step 1:** 过滤列表显示 1…N；数字键 1–9 选中
- [ ] **Step 2:** 菜单头文案更新；帮助「常用指令」同步序号
- [ ] **Step 3:** Commit `feat(web): number slash commands for quick pick`

---

### Task 5: 验证与收尾

- [ ] 跑 `backend/tests/run_all.py`
- [ ] 手动/浏览器：侧栏顺序、Alt、脚本 CRUD/执行、`/` 序号
- [ ] 更新 PR；走 finishing-a-development-branch

## Spec coverage checklist

| Spec 节 | Task |
|---|---|
| §1 侧栏与快捷键 | 3 |
| §2 磁盘与 frontmatter | 1 |
| §3 API | 2 |
| §4 ScriptPane UI | 3 |
| §5 斜杠序号 | 4 |
| §6 测试 | 1, 5 |
| accept.* 不动 | 全任务约束 |
