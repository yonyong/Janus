# 通用验收脚本工作流 实施计划

原则：**用例是账本，脚本是跑法**；AI 只在「生成/更新脚本」时推理，日常验收只跑脚本。

## 一需求一份脚本

- 入口文件：`.janus/{需求目录}/usecase/accept.*`（默认 `accept.py`；支持 `accept.py/.sh/.mjs/.js`）。
- 脚本职责：读同目录用例清单 `usercase.md`（平台已导出）→ 跳过标「人工」用例 → 按标题逐条检查 → 输出平台能解析的结果表，沿用 `arch/test-result.md`（表头：用例 | 标题 | 结果 | 说明）。
- 复杂加工（场景四）：脚本内部可调项目方法 / skill / 查库；用例只保留标题 + 预期。

## 数据模型

- `test_cases.is_manual INTEGER DEFAULT 0`（迁移，幂等）。默认否；目视样式类勾「人工」。
- `TestCaseRepo` create/update/create_many 支持 `is_manual`；`stats` 增加 `manual`、`manual_pending`（人工且 pending）。

## 后端

- `docs.accept_script(dir)` 路径 + `accept_candidates`；`export_test_cases` 每条标注「人工：是/否」，头部补「总验收脚本」约定。
- 新模块 `acceptance.py`：
  - `find_script` / `script_status(conn,rid,root,dir)`：存在？路径、mtime、是否过期（任一用例 updated_at 晚于脚本 mtime）、入口语言。
  - `run_script(root,dir,timeout)`：按扩展名选解释器（py→python3 / sh→bash / mjs,js→node），`cwd=disk_path`，净化 env，捕获输出与退出码，超时保护。
- `test_report.report_titles(content)`：从报告「标题」列取标题集合，供覆盖度判定（未覆盖 = 非人工且不在报告标题里）。
- 接口：
  - `GET /api/requirements/{rid}/accept-script`：脚本状态 + 覆盖度（covered_titles / uncovered 计数）。
  - `POST /api/requirements/{rid}/accept-script/run`：跑脚本 → `sync_cases` 回写 → 返回退出码/输出/同步结果；审计留痕。
- `CaseIn`/`CaseUpdate` 增 `is_manual`；workflow/stats 透出 manual 计数。

## 前端

- `api.ts`：`TestCase.is_manual`，`acceptScriptStatus`、`runAcceptScript`，Case 输入类型加 is_manual。
- `CasePane`（用例 Tab = 配置 + 入口）：
  - 脚本状态条：无脚本 / 已生成(时间) / 用例已变请更新；「打开脚本」跳项目文件对应文件。
  - 三个主操作：**生成/更新验收脚本**（右侧对话灌入固定指令）、**执行验收**（调 run 接口 → 写报告 → sync 回红绿）、**仅人工核对**（筛人工项逐条勾通过/失败 + 备注）。
  - 用例行：`人工` 开关；标记 `人工 / 已进脚本 / 未覆盖`。
- `ArchivePane`：汇总增「人工待核」；有失败不假装全绿（保持现状，可带备注归档）。
- `FlowCommands`：新增两条与按钮同义的指令文案（生成/更新总验收脚本、执行总验收脚本并写测试报告）。

## 明确不做

- 不强绑固定验收类型枚举；不默认一用例一脚本；不做像素级自动比对（场景一走人审）；第一版不搞多套件多脚本。

## 验证

- 单测：acceptance（脚本状态/过期判定/run 解释器选择/覆盖度）、report_titles、is_manual stats。
- 端到端：demo 工程放一个 `accept.py`，跑 run 接口 → 验证 `test-result.md` 生成、用例状态回写、覆盖度。
- 浏览器走查：用例 Tab 三按钮、脚本状态条、人工勾选、归档「人工待核」。
