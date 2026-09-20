---
role: technical-design
status: final
topic: script-tab-and-slash-numbers
---

# 脚本 Tab 与斜杠指令序号 — 设计 Spec

## 背景与目标

工作台左栏需要独立的「脚本」能力：在 `.janus/{需求目录}/script/` 下管理可参数化脚本，支持编辑、执行、日志与 AI 协助起草；同时右侧对话输入 `/` 唤起常用指令时展示序号，便于快速定位。

**非目标：** 不迁移、不替换现有用例面板的总验收脚本 `usecase/accept.*`；不把脚本元数据写入 SQLite（权威在磁盘）。

## 决策摘要

| 项 | 选择 |
|---|---|
| 参数声明 | 脚本文件 YAML frontmatter |
| 参数传递 | CLI `--name value` |
| AI 协助 | 面板按钮 → 灌入右侧对话话术（不自动发送） |
| 验收脚本 | 保留在用例面板 / `usecase/accept.*` |
| 存储与历史 | 方案 1：磁盘脚本 + `.runs/{stem}.json` |

## 1. 侧栏与快捷键

左栏竖向顺序与 Alt 快捷键：

| Alt | Cat | 显示名 | 原名 |
|---|---|---|---|
| 1 | `req` | 需求 | 需求文档 |
| 2 | `code` | Files | 项目文件 |
| 3 | `script` | 脚本 | （新增） |
| 4 | `cases` | 用例 | — |
| 5 | `arch` | 归档 | — |
| 6 | `help` | 帮助 | — |

改动点：

- `FileWorkArea.tsx`：`Cat` 增加 `'script'`；`cats[]` 按上表重排；渲染 `ScriptPane`
- `STAGE_CAT`：`build` 仍默认 `code`（Files），不默认进入脚本
- `Workbench.tsx` 热键 map、`shortcuts.ts`、`HelpPanel` 文案同步 Alt+1…6
- 用例面板「打开脚本」若指向验收脚本 / 项目文件，保持原行为，不误跳新「脚本」tab

## 2. 磁盘布局与文件格式

```
.janus/{dir}/script/
  foo.py
  bar.sh
  .runs/
    foo.json
```

- 枚举一层 `*.py` / `*.sh` / `*.js` / `*.mjs`；忽略点开头与 `.runs/`
- 解释器与验收脚本一致：`python3` / `bash` / `node`
- 路径助手加入 `backend/docs.py`（如 `script_dir`、`script_path`、`script_runs_path`）
- `snapshots.IGNORE_DIRS` 已含 `.janus`，无需额外处理

### Frontmatter

```yaml
---
name: 部署预检          # 可选；缺省用文件名（去扩展名）
desc: 检查环境依赖
params:
  - name: env
    label: 环境
    type: string        # string | number | boolean
    default: staging
    required: true
  - name: dry_run
    label: 试跑
    type: boolean
    default: true
---
```

执行约定：

- 去掉 frontmatter 后写入临时文件再执行（避免 shebang/解释器读到 `---`），或对 `.sh` 等价处理；工作目录为项目 root
- 参数统一：`--{name} {value}`；`boolean` 以字符串 `true` / `false` 传递；缺省且非 required 的参数可省略
- 超时、输出截断对齐验收脚本（600s、约 20k 字符）

### `.runs/{stem}.json`

```json
{
  "last_params": { "env": "staging", "dry_run": "true" },
  "runs": [
    {
      "id": "20260920T083000Z",
      "started_at": "...",
      "exit_code": 0,
      "params": {},
      "output": "...",
      "duration_ms": 1234
    }
  ]
}
```

保留最近 20 条；每次成功发起执行后更新 `last_params`（含失败退出码的执行也记入 `runs`）。

## 3. API

新模块 `backend/scripts.py`；路由挂在 requirement 下（需 `_require_requirement` + 项目 root）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/requirements/{rid}/scripts` | 列表：filename、display name、desc、params、last_params、mtime |
| GET | `/api/requirements/{rid}/scripts/{name}` | 原文 + 解析 meta |
| PUT | `/api/requirements/{rid}/scripts/{name}` | 保存/新建正文 |
| DELETE | `/api/requirements/{rid}/scripts/{name}` | 删脚本及对应 `.runs` |
| POST | `/api/requirements/{rid}/scripts/{name}/run` | body `{ params }` → 执行并追加记录 |
| GET | `/api/requirements/{rid}/scripts/{name}/runs` | 执行记录 |

安全：

- `{name}` 仅为 basename，且扩展名白名单；拒绝 `..`、路径分隔符
- 落盘必须在 `script/` 目录 realpath 之下

前端：`web/src/api.ts` 增加对应类型与客户端。

## 4. 脚本面板 UI

新组件 `ScriptPane.tsx`。

**顶栏：** 新建脚本（文件名 + 扩展名，空模板含最小 frontmatter）、AI 协助写脚本（`onUseCommand`）、刷新。

**列表行：** 显示名 · desc · 操作：参数 / 编辑 / 执行 / 日志。

| 操作 | 行为 |
|---|---|
| 参数 | 表单按 frontmatter 渲染，预填 `last_params`；可「保存参数并执行」 |
| 编辑 | 全文编辑（TextArea）；PUT 保存 |
| 执行 | 用 `last_params` 或默认值直接跑；缺必填时先打开参数表 |
| 日志 | runs 列表，展开看 output / exit_code / 当时参数 |

运行中禁用该行操作；结束后刷新并定位最新日志。无需求选中时禁用。`HelpPanel` 补充：通用脚本在 `script/`，与 `usecase/accept.*` 分离。

AI 话术约定（示意）：请 Agent 在 `.janus/{dir}/script/` 下创建或更新带 frontmatter 的脚本，说明 params 与 CLI 传参约定。

## 5. 斜杠菜单序号

改动 `ChatPanel.tsx`（及少量 CSS）：

- 当前过滤结果左侧显示 `1…N`（样式参考 `fc-num`，类名 `slash-item-num`）
- 菜单打开时数字键 `1`–`9` 选中对应项；超过 9 仍用 ↑↓ + Enter
- 序号按**当前可见列表**重排
- 菜单头：`常用指令 · 数字键快速选 · ↑↓ · Enter · Esc`
- 帮助面板「常用指令」列表同步加序号（同 PR）
- 不强制把脚本 AI 话术加入 `/` 指令列表

## 6. 测试

- 后端：`backend/tests/test_scripts.py` — 列表/保存/非法名拒绝、frontmatter 解析、run 传参与 `.runs` 更新、输出截断
- 前端：手动验证侧栏顺序与 Alt+1…6、脚本 CRUD/执行/日志、`/` 序号与数字键
- 回归：现有 `test_acceptance.py` 仍通过；用例验收脚本行为不变

## 7. 主要改动文件

- `backend/docs.py`、`backend/scripts.py`（新）、`backend/app.py`
- `backend/tests/test_scripts.py`（新）
- `web/src/components/ScriptPane.tsx`（新）、`FileWorkArea.tsx`、`Workbench.tsx`、`ChatPanel.tsx`、`HelpPanel.tsx`、`shortcuts.ts`、`api.ts`、`styles.css`
- `web/src/components/FlowCommands.tsx`（仅当 AI 话术辅助函数需要时）

## 开放细节（实现时可定，不阻塞）

- 临时文件清理时机（进程结束后立即删）
- boolean 在 UI 用 Switch，序列化为 `true`/`false` 字符串
- 新建默认模板语言优先 `py`
