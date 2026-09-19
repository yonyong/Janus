# Janus（coding-agent-platform）长期项目笔记

## 定位
本地 Web 平台：业务人员凭令牌分享链接在沉浸式工作台里用对话召唤 coding agent 改代码。
FastAPI + stdlib(sqlite3) 后端（coding-agent-platform/backend），React 18 + Vite + antd 6 前端（web/）。

## 认证架构（改动前必读）
- 唯一登录入口 `web/src/components/AuthLoginModal.tsx`（令牌登录 / 管理员口令登录）；
  登录态唯一来源 `AuthProvider.tsx` + `auth.ts`（`useAuth()` / `useToken()`）。
- 凭证存 localStorage（cap_access_token / cap_admin_token），写入派发 `cap-auth-change` 事件，
  Provider 监听重算——**不要用 window.location.reload**。只有 401/403 才踢下线。
- 未登录时 App 壳层不挂载路由（只渲染 LockedPlaceholder）。
- 服务端 `resolve_access(db, token, admin)` 是唯一鉴权入口；`GET /api/admin/verify` 仅登录校验用。
- 开放模式（无 CAP_ADMIN_TOKEN）≠ 无需登录，业务数据仍要令牌。当前 `.env`：`CAP_ADMIN_TOKEN=janus-admin-3ead5e`。

## 验证命令（改完必须跑；cd coding-agent-platform 后）
```bash
./.venv/Scripts/python.exe backend/tests/run_all.py        # 单测，看 failed=0
./.venv/Scripts/python.exe tools/smoke_*.py                # 各 HTTP 冒烟（file/workflow/docs/versions/admin_edit/agent_probe/agent_quota/audit）
cd web && node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/vite/bin/vite.js build                   # 产出 web/dist（后端静态托管）
node tools/ui_smoke_auth.mjs http://127.0.0.1:8000 janus-admin-3ead5e
node tools/ui_smoke_workbench.mjs "http://127.0.0.1:8000/?token=<令牌>#/workbench/6"
```
- **新增路由必须补 HTTP 冒烟**（`tools/_smoke_common.py` 脚手架；单测直调路由会绕过 Depends 与
  `?token=` 解析；跑 agent 链路必须用 `Smoker.stream_run(sid,msg,token=...)`；替身适配器注册**传实例不传类**）。
- **给路由参数加 `Depends` 会让单测全线炸**：单测直调路由函数，Depends 默认值会被当真实对象。
  修法：函数体内对它做空实现兜底，或所有直调处（tests/*.py、tools/smoke_*.py）显式传 no-op。

## 需求工作流要点
- 四阶段展示：需求澄清(clarify) → 用例配置(verify) → 编码实现(build) → 归档验收(archive)。
  仅 archive 单栏无对话；verify 也有右侧对话（2026-09-19 起）：快捷指令让 Agent 写用例草稿
  `.janus/{dir}/usecase/cases-draft.md`，对话结束 Workbench 自动调
  `POST /api/requirements/{rid}/cases/import` 落库（同标题跳过、导入后删草稿）——
  页面上没有导入按钮，别按旧文档加回来。
  「一键生成用例」按钮已移除（后端 /cases/generate 180s 探针接口还在，前端无入口）。
  用例支持勾选批量删除（POST /api/cases/batch-delete，整批校验不部分删）。
- 需求标题：**创建时后端自动加 `v-yyyyMMddHHmmss-` 前缀**（`app.py::_apply_req_title_prefix`，
  已带前缀不重复加）；创建后标题不可改（.janus/ 目录名依赖标题）。
- 文档镜像到工作区 `.janus/docs/`（requirement.md/design.md/test-cases.md）；附件在 attachments 表。
- 版本历史（requirement_versions）：PATCH 带 source 才记版；restore 是把旧内容当新修改写回再记一版；
  `db.py::_backfill_versions` 幂等补老需求的 create 版。
- 改动记录（change_sets，backend/snapshots.py）不依赖 git：agent 运行前后快照 diff，finally 里落库；
  二进制只记指纹不可回退；回退本身也记 revert 记录。
- 前端关键组件类名（ui_smoke_workbench.mjs 依赖，勿改）：`.case-pane/.chg-pane/.chg-set/.vh-item/.arc-card/.wb-tabs/.doc-editor`。

## 工作台文件预览（2026-09-19 起）
- 后端：`GET /api/projects/{pid}/file/raw`（`?download=true` 附件头）+ `GET .../raw/{rel_path:path}`
  （路径内嵌版，HTML 预览 iframe 专用，页面相对引用靠它解析）；`files.raw_meta` 做 MIME + 64MB 上限。
- 前端：`web/src/components/FileViewer.tsx` 按扩展名分流（xlsx/csv=SheetJS、pdf/image=原生、
  docx=docx-preview、html=sandbox iframe、md=marked+DOMPurify、代码=highlight.js lib/common）；
  FilePane 弹窗 Segmented：html/md=预览|源码、代码=语法高亮|源码、纯文本直编辑。
- 注意：docx-preview@0.4 无独立 CSS（JS 注入），import 其 min.css 会炸 build；CDP 冒烟脚本
  message handler 必须 `p.resolve(m)` 整条消息，resolve(m.result) 会让 evaluate 全静默返回 undefined。
- 新增 `tools/ui_smoke_preview.mjs`（CDP 端到端预览冒烟，html/md/java/xlsx）。

## Agent 探测与宿主环境变量（最易复发）
- 宿主会注入会话环境变量（SERVER__PORT、CODEBUDDY_*/CLAUDE_* 等）给子进程 → codebuddy CLI 误判
  在宿主网关内 → EADDRINUSE 静默挂死。**适配器 subprocess 必须过 `adapters/codebuddy.py::_clean_env()`**。
- 超时终止要连进程树杀（`taskkill /F /T /PID`）；目录回收用 `agent_test._rmtree_with_retry`。
- 排查"超时"：先查孤儿进程 → 换目录对照 → `env | grep` 找宿主注入；别信前端归因文案。

## 运行中止（2026-09-19 起）
- `POST /api/sessions/{sid}/abort`：真中止（asyncio cancel → 适配器 finally 连进程树杀），
  非页面假停。session_service 用 done-callback 兜底（协程未启动就被 cancel 时 finally 不执行）。
- 语义：半截输出不落库、SSE 广播 abort+done、被中止消息可重发（新建 run）；审计 session.abort。
- 前端 ChatPanel 停止按钮；核心类名/接口改动要同步 tools/_smoke_common.py 生态。
- 真 CLI 进程级验证脚本 tools/_verify_abort_real_cli.py（一次性，node 进程差集核验）。

## 环境坑
- Bash 工具 PATH 缺 /usr/bin：每条命令前缀 `export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"`；
  taskkill 用单斜杠参数（`//F` 无效）。
- 前端 vite build 后刷新即生效；**Python 改动必须重启后端**。后台服务用 run_in_background，勿裸 `&`。
- 起服务：`./.venv/Scripts/python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port <p>`。
- **仓库常有第二个工作流并行改代码**：文件被改/无关测试失败/8000 端口被顶都是正常现象。
  处置：grep 确认自己符号还在 → HTTP 冒烟验证自己链路 → 别动对方代码、别"修"无关失败。
- antd 是 6.x（Tree 无 expandAction、Modal 用 destroyOnHidden），传未声明属性直接 TS 报错。
- 删除操作被 safe-delete 包装：常报 SAFE_DELETE_FAIL_CLOSED 但其实已删，用目录列表复核，别重试。
- 平台只有一个管理员（CAP_ADMIN_TOKEN），无多角色体系；业务侧写操作只需 ?token=。
- **`Config.db_path` 硬编码 `BASE/data/app.db`，无环境变量覆盖**（CAP_DB_PATH 无效）：
  临时库验证必须 `from backend import config; config.CONFIG.db_path = <临时路径>` 后再 get_conn，
  否则会污染真实库（2026-09-19 踩过，靠 .janus 镜像文档恢复）。

## Token 用量与审计
- Agent token_limit 是**日限额**（2026-09-19 起）：usage_map 只统计当日 total_tokens（date(created_at)=date('now','localtime')），当日用满不可用、次日自动重置；0=不限额，默认 1000 万/天。
- codebuddy 适配器 `--output-format json`：stdout 是事件数组，取最后带 usage 的 assistant 消息。
- 审计 backend/audit.py：写不进库先进 deferred 队列；接口 /api/admin/audit-logs、/api/admin/invocations；
  页面 /audit/logs、/audit/tokens（仅管理员）。CDP UI 冒烟调试端口 `9336 + pid%400`，收尾 taskkill /T /F。
