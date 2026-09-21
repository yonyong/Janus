# Janus（coding-agent-platform）长期项目笔记

## 定位与技术栈
本地 Web 平台：业务人员凭令牌分享链接，在沉浸式工作台里用对话召唤 coding agent 改代码。
后端 FastAPI + stdlib sqlite3（coding-agent-platform/backend）；前端 React 18 + Vite + antd 6（web/）。

## 认证架构（改动前必读）
- 唯一登录入口 `web/src/components/AuthLoginModal.tsx`（令牌 / 管理员口令两模式）；登录态唯一来源
  `AuthProvider.tsx` + `auth.ts`（`useAuth()` / `useToken()`）。
- 凭证存 localStorage（cap_access_token / cap_admin_token），写入派发 `cap-auth-change`，Provider 监听
  重算——**别用 window.location.reload**；只有 401/403 才踢下线。未登录时 App 壳层不挂载路由。
- 开放模式（无 CAP_ADMIN_TOKEN）≠ 免登录；`resolve_access(db, token, admin)` 是服务端唯一鉴权入口；
  管理员口令走 **query `admin=`**，非 header。
- **弹框 UI（2026-09-21 定稿，宽版 920 两栏）**：左 `.auth-brand` 品牌渐变栏（Logo 与品牌名在左栏水平
  居中 + 标语 + 3 条要点；≤880px 收成顶部品牌条、隐藏要点）＋ 右 `.auth-panel` 表单面板
  （`.auth-panel-title` / `.auth-panel-sub` / `.auth-hint`；输入框与提交按钮同宽）。Modal **不再用 `title`
  prop**，登录标题在右栏 → `ui_smoke_auth.mjs` 判弹框态用的是 `.auth-panel-title`，改结构必须同步脚本。
  跑 UI 冒烟前先 `grep CAP_ADMIN_TOKEN .env`（口令被改过，别硬背）。

## 验证命令（改完必须跑；cd coding-agent-platform 后）
```bash
./.venv/Scripts/python.exe backend/tests/run_all.py        # 单测，看 failed=0
./.venv/Scripts/python.exe tools/smoke_*.py                # 各 HTTP 冒烟
cd web && node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/vite/bin/vite.js build                   # 产出 web/dist（后端静态托管）
node tools/ui_smoke_auth.mjs http://127.0.0.1:8000 <管理员口令>
node tools/ui_smoke_workbench.mjs "http://127.0.0.1:8000/?token=<令牌>#/workbench/6"
node tools/ui_smoke_logs.mjs / ui_smoke_audit.mjs ...        # 其余 CDP 冒烟见 tools/
```

## 对话输入框（Composer，2026-09-21 改版）
- 结构：`.composer-box`（圆角盒 + `:focus-within` 高亮）= 正文 `textarea`（antd `variant="borderless"`，
  边框由外层盒承担）+ 内嵌工具条 `.composer-tools`。左下 `+`（aria-label=添加内容）→ 上传文件 / 上传图片 /
  常用指令（填 `/` 唤起斜杠菜单）；右下 = Agent chip（`.composer-chip.composer-agent`，**仅多 Agent 会话出现**）
  → 停止 → 圆形发送（`.composer-send`）。原回形针按钮已并入 `+`，外置 `.chat-agent-bar` 已删除。
- Agent 相关 props（`agents/agentId/onChangeAgent/agentSwitching`）由 Workbench → RequirementPane → ChatPanel 透传。
- **坑**：antd 6 按钮 `shape="circle"` 的 `min-width:34px` 是运行时注入样式，压不掉 → 不用该形状，
  尺寸与 `border-radius:50%` 全走自定义类。
- 一次性验证脚本 `tools/_verify_composer_once.mjs <带token的工作台URL>`（CDP 9339，全绿才收工）。
- **新增路由必须补 HTTP 冒烟**（`tools/_smoke_common.py` 脚手架；单测直调路由会绕过 Depends 与 `?token=`
  解析；跑 agent 链路用 `Smoker.stream_run(sid,msg,token=...)`；替身适配器注册传实例不传类）。
- **给路由参数加 `Depends` 会让单测全线炸**（直调时默认值被当真实对象）：函数体内兜底或直调处传 no-op。

## 需求工作流要点
- 四阶段：需求澄清(clarify) → 用例配置(verify) → 编码实现(build) → 归档验收(archive)。
  **2026-09-20 工作台 UI 重做（用户定稿）**：顶部步骤条、标准/轻量模式切换均已移除（后端
  requirement.mode 字段还在但前端不读写）；**阶段感知入口现在是输入框内 `/` 指令菜单**（Workbench 把
  `buildFlowCommands()` 结果作为 `commands` 传进 ChatPanel）——`FlowCommands.tsx` 里的默认导出组件已无
  任何渲染入口（`.flow-cmds/.fc-row` 已不出现），故 ui_smoke_workbench/preview 里「等流程指令清单」的
  断言是过期脚本问题，别当成回归。旧清单行为：6 条指令跨阶段连续编号、按产出判「已完成」/「建议下一步」，
  点击 = changeStage + loadDraft。左栏 `FileWorkArea.tsx`：竖向分类页签（需求文档/用例/归档/项目文件，
  阶段→分类单向联动）+ 分类内横向子页签，编码分类只有「文件/改动」；分栏可拖拽（320px~62%，双击复位）+ 收起。
- verify 的用例草稿写 `.janus/{dir}/usecase/cases-draft.md`，对话结束自动调
  `POST /api/requirements/{rid}/cases/import`（同标题跳过、导入后删草稿）；用例可勾选批量删除
  （`POST /api/cases/batch-delete`）。需求标题创建时后端自动加 `v-yyyyMMddHHmmss-` 前缀
  （`app.py::_apply_req_title_prefix`）且事后不可改（.janus/ 目录名依赖标题）。
- 文档镜像到 `.janus/docs/`；附件在 attachments 表。版本历史（requirement_versions）：PATCH 带 source
  才记版，restore 把旧内容当新修改写回再记一版，`db.py::_backfill_versions` 幂等补 create 版。
- 改动记录（change_sets，backend/snapshots.py）不依赖 git：运行前后快照 diff，finally 落库；二进制只记
  指纹不可回退；回退本身也记 revert。
- 前端关键类名（冒烟依赖，勿改）：`.case-pane/.chg-pane/.chg-set/.vh-item/.arc-card/.wb-tabs/.wb-tab/
  .doc-editor/.fp-node`；新版 `.wfa-rail-item`、`.fc-row`、`.wb-stage-chip`、`.wb-split`。WorkflowSteps.tsx 已删。

## 文件预览 / 本地路径选择
- 预览后端：`GET /api/projects/{pid}/file/raw`（`?download=true`）+ `.../raw/{rel_path:path}`（路径内嵌版，
  HTML iframe 专用）；`files.raw_meta` 做 MIME + 64MB 上限。前端 `FileViewer.tsx` 按扩展名分流
  （xlsx/csv=SheetJS、pdf/image=原生、docx=docx-preview、html=sandbox iframe、md=marked+DOMPurify、
  代码=highlight.js）；FilePane 弹窗 Segmented 切预览|源码，支持全屏（Esc 先退全屏，CSS 挂
  `.fv-modal-fullscreen .ant-modal-container`）。坑：docx-preview@0.4 无独立 CSS（import min.css 会炸 build）；
  CDP 脚本 message handler 必须 `p.resolve(m)` 整条消息，`resolve(m.result)` 会让 evaluate 静默返回 undefined。
  冒烟 `tools/ui_smoke_preview.mjs`。
- 本地工程路径 = `FolderPathInput.tsx`：桌面端调 pywebview `pack_launch.py::DesktopApi.select_folder()`
  （取消返回空串），浏览器端弹 `DirPickerModal.tsx`；列目录接口 `GET /api/admin/fs/dirs?path=`（仅管理员，
  只列目录）。**别用 `webkitdirectory`**（弹上传确认框且拿不到绝对路径）。冒烟 `tools/smoke_fs_dirs.py`（8034）。

## Agent 探测与宿主环境变量（最易复发）
- 宿主注入的会话环境变量（SERVER__PORT、CODEBUDDY_*/CLAUDE_* 等）会让 codebuddy CLI 误判在宿主网关内
  → EADDRINUSE 静默挂死。**适配器 subprocess 必须过 `adapters/codebuddy.py::_clean_env()`**。
- cursor 规格必须带 `--trust`（_CLI_SPECS），否则 cursor-agent 在临时目录弹 Workspace Trust 直接失败。
- 超时终止要连进程树杀（`taskkill /F /T /PID`）；目录回收用 `agent_test._rmtree_with_retry`。
- 排查「超时」：先查孤儿进程 → 换目录对照 → `env | grep` 找宿主注入；别信前端归因文案。

## 运行中止
`POST /api/sessions/{sid}/abort`：真中止（asyncio cancel → 适配器 finally 连进程树杀），session_service 用
done-callback 兜底。语义：半截输出不落库、SSE 广播 abort+done、被中止消息可重发；审计 session.abort；
前端 ChatPanel 停止按钮。

## 环境坑
- Bash 工具 PATH 缺 /usr/bin：每条命令前缀 `export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"`；
  taskkill 用单斜杠参数（`//F` 无效）。
- 前端 vite build 后刷新即生效；**Python 改动必须重启后端**；后台服务用 run_in_background，勿裸 `&`。
  起服务：`./.venv/Scripts/python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port <p>`。
- **仓库常有第二个工作流并行改代码**：文件被改、无关测试失败、8000 端口被顶都正常。处置：grep 确认自己
  符号还在 → 跑自己的冒烟 → 别动对方代码、别"修"无关失败。
- antd 6.x：传未声明属性直接 TS 报错（Tree 无 expandAction、Modal 用 destroyOnHidden）；面板类名
  `.ant-modal-container`（非 v5 content），styles 无 content 键；wrapClassName 的类关窗后仍残留 DOM
  （判断弹窗态要用内容元素）；两字按钮被插空格，点按钮用 `/关\s*闭/`。
- 删除被 safe-delete 包装：常报 SAFE_DELETE_FAIL_CLOSED 但其实已删，用目录列表复核，别重试。
- 只有一个管理员（CAP_ADMIN_TOKEN），无多角色；业务侧写操作只需 `?token=`。
- **`Config.db_path` 硬编码 `BASE/data/app.db`，CAP_DB_PATH 无效**：临时库验证必须
  `config.CONFIG.db_path = <临时路径>` 后再 get_conn，否则污染真实库。
- Agent token_limit 是**日限额**（当日用满不可用、次日重置；0=不限额，默认 1000 万/天）；
  codebuddy 适配器 `--output-format json` 取最后带 usage 的 assistant 消息。
- 审计 `backend/audit.py`：写不进库先进 deferred 队列；接口 /api/admin/audit-logs、/api/admin/invocations；
  页面 /audit/logs、/audit/tokens。CDP 冒烟调试端口 `9336 + pid%400`，收尾 taskkill /T /F。

## 桌面应用打包（2026-09-21 起）
- `pack.bat`（图标→依赖→前端→PyInstaller）+ `pack_launch.py`（pywebview 启动器）；产物
  `dist\Janus\Janus.exe`，日志 `dist\Janus\logs\janus.log`。
- **PyInstaller 6.x onedir 把 `--add-data` 资源放进 `dist/Janus/_internal/`（= sys._MEIPASS）**。启动器必须
  区分 `RES_DIR`（_MEIPASS，只读：web/dist、assets）与 `APP_DIR`（exe 旁，可写：data/、logs/），否则
  前端 404 + 数据库写不进。
- **配置外置到 exe 同级 `config.ini`**（`[server]`/`[admin]`/`[share]`/`[log]`），不再打包内置 .env；
  `_ensure_config_ini()` 首启生成（口令随机；exe 旁有 .env 则迁移其值），`_apply_ini()` 同时写 CONFIG 与
  os.environ；打包收尾 `tools/make_config_ini.py dist/Janus` 生成模板。
- 图标：`assets/janus-icon.svg` → `tools/make_icon.mjs` → `assets/janus.ico`（7 尺寸，pefile 读 RT_ICON 验证）；
  Windows 窗口/任务栏图标继承 exe（`webview.start(icon=)` 只在 GTK/QT 生效）。
- 端口自动顺延（8000..8049），`_port_free` 要同时探 127.0.0.1 与 0.0.0.0；单实例用命名互斥体
  `Local\JanusDesktopApp` + FindWindow 唤起原窗口。
- pip 清华镜像不可达，用 `--index-url https://pypi.org/simple`；覆盖旧 dist 触发 safe-delete 拦截：
  先 `mv dist/Janus dist/_tmp` 再打包。发布前确认 config.ini 的随机口令；目标机器需 WebView2 运行时。
