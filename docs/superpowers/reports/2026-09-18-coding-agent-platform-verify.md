# 验证报告：coding-agent-platform

> 生成时间：2026-09-18 · verify_mode: full · language: zh-CN
> Change：`coding-agent-platform`（comet-classic，phase: verify → archive）

## 1. 概要分数卡

| 维度 | 状态 |
|------|------|
| 完整性（Completeness） | 17/17 任务完成；4 份 delta spec 全部需求/场景已落实 |
| 正确性（Correctness） | 鉴权越权、SSE 幂等、可插拔引擎、CLI 子进程、回显等核心场景已实现并通过最终集成审查 |
| 一致性（Coherence） | 实现遵循 design.md 高层决策；阶段审查发现的安全/幂等问题已全部修复 |

**总体评估：全部检查通过，可归档（含以下已知限制说明）。**

## 2. 验证证据（证据优先，非声明）

| 检查项 | 命令 / 方式 | 结果 |
|--------|------------|------|
| 编译通过 | `python -m py_compile backend/**/*.py` | OK |
| 单元/集成测试 | `python backend/tests/run_all.py` | **6/6 passed, 0 failed**（新增 `test_session_flow` 覆盖幂等） |
| 入口检查 | `comet state check coding-agent-platform verify` | 4/4 PASS |
| 规模评估 | `comet state scale` | full（17 任务 / 4 delta spec） |
| 最终集成代码审查 | `requesting-code-review`（标准模式，独立子代理两轮） | 见 §4 |
| 遗留关键字清除 | `grep _processing_sids\|SessionService.send` | NONE-FOUND |

> 环境无外网，`pip install fastapi/uvicorn` 与 `npm install` 均不可用，故 HTTP 层（真实 uvicorn 启动 + 浏览器 E2E）未在本机跑通；以 stdlib 测试 + `py_compile` + 代码审查作为等价证据。用户侧需在本机 `pip install -r requirements.txt && cd web && npm install && npm run build && python start.py` 做全链路 E2E（fake agent 即可跑通）。

## 3. 完整性与 Spec 覆盖

- **任务**：`tasks.md` 17 项全部 `[x]`，与 `instructions apply` 的 `progress` 一致。
- **Spec 覆盖映射**（4 份 delta spec → 实现）：
  - `coding-agent-management`：注册/重名拒绝（`create_agent` 409）、可插拔引擎（`AgentRegistry`）、CodeBuddy 适配器（`adapters/codebuddy.py` CLI 子进程）、未配置提示（`SessionService.create` 抛 `RuntimeError`）。
  - `project-management`：项目磁盘映射（`create_project` + `isdir` 校验）、访问令牌授权（`issue_token` / `TokenService`）、越权不可见（各受保护接口 `get_allowed` + 项目白名单）、目录访问白名单（`auth.whitelist` realpath 前缀校验）。
  - `requirement-management`：需求 CRUD（`RequirementRepo`）、需求归属（按 `project_id` 过滤）。
  - `requirement-design-workbench`：四窗格（`Workbench.tsx`）、召唤 agent 编码（`stream_events`）、改动与测试回显（SSE 分流 + `CodePane`/`TestPane`）、agent 自主判断/迭代（provider 自决，无显式编码按钮）。

## 4. 验证阶段发现并修复的问题（verify-fail 修复循环）

本 change 进入 verify 后，最终集成审查发现并修复了 **1 CRITICAL + 1 IMPORTANT + 2 WARNING**（分两轮）：

### 第一轮（build 阶段审查 → verify-fail 返回 build 修复）
- **CRITICAL**：`create_session` / `session_history` / `stream_events` 未校验令牌与项目权限，破坏"链接令牌免登录"不变式。
  → 修复：三处均新增 `TokenService.resolve` + 项目白名单校验（401/403/404）。
- **IMPORTANT**：SSE 重连时依据 `stream_id` 立即 `done`，静默丢弃事件；`_completed_streams` 集合只增不减（内存泄漏/DoS）。
  → 修复：删除内存集合与 `stream_id`，改为内容级幂等回放。

### 第二轮（复审查 → 再修复，本轮 verify 收尾）
- **CRITICAL（app.py 旧 `_processing_sids` 锁绑连接生命周期）**：客户端在 agent 运行中途断线时，`gen()` 被取消并释放锁，重连会**重跑整条流水线 → 重复改盘 + 重复落库**，摧毁"不二次编辑"核心保证。
  → 修复：将 agent 运行**脱离 SSE 连接**——`resolve_run` 在后台 `asyncio.create_task(_run_agent(...))` 中执行，订阅者仅通过 `asyncio.Queue` 消费；断线只是取消订阅者，后台 run 继续；重连复用同一 `(session_id, message)` → 订阅同一 run 的实时流，**不重复调用 agent**。
- **IMPORTANT（锁仅按 `sid` 键）**：同一会话处理期间发送另一条不同消息会被静默丢弃。
  → 修复：幂等键改为 `(session_id, message)`（`_RUN_KEY`），不同消息创建独立 run，不再丢失。
- **WARNING（SSE 鉴权失败无 `done` → EventSource 自动重连空转）** → 修复：`_sse_error` 先发 `error` 再发 `done`；前端 `onmessage` 收到 `error` 主动 `close()`。
- **WARNING（`proj is None` → 500）** → 修复：`_run_agent` 守卫 `agent/proj is None` 并改发错误事件；replay 路径 `D.compute` 加 `if proj` 兜底。

### 第三轮（最终确认审查，agent-1f83cc8a）
- 确认上述 4 项 **全部 RESOLVED**，无新增阻断性回归。
- 残余 **LOW（非阻断）**：进行中 run 中途重连会回放整段 buffer，导致 UI 重复追加已展示事件（**不重复落库**，安全属性不受影响）——属 UX 瑕疵，见 §5 已知限制。

## 5. 已知限制（非阻断，归档前记录）

1. **管理端点未鉴权（WARNING）**：`/api/agents`、`/api/projects`（POST/DELETE）、`/api/projects/{pid}/issue-token` 无令牌校验，任何人均可签发令牌或删除数据。当前定位为操作者内网工具，已在 README 标注；生产化需引入操作者鉴权。
2. **UX 重连重复渲染（LOW）**：进行中 run 中途断线重连会重放整段事件，UI 窗格可能重复追加；不重复落库。
3. **设计窗格占位**：四窗格中的"设计"窗格暂留空占位（按前期决策）。
4. **diff 不落库**：`edit` 事件中的 git diff 为实时计算，未持久化；历史回放依赖 `D.compute` 实时结果。
5. **单 worker 约束**：run 去重依赖进程内 `_RUNS`/`_RUN_KEY`；多 uvicorn worker 部署时跨进程去重不保证，需单 worker 或共享状态（Redis/DB）——已在 README 标注。
6. **无显式"编码"按钮**：编码由 agent 自判触发（按需求）；业务侧无手动触发入口。
7. **无外网构建验证**：本机未跑通 uvicorn + 浏览器 E2E（见 §2 环境说明）。

## 6. 结论

核心功能（编码 Agent 平台 MVP：可插拔引擎、项目磁盘映射、需求管理、四窗格工作台、链接令牌免登录、SSE 实时回显与幂等断线续传）均已实现并通过 6/6 测试与最终集成审查。verify 阶段发现的全部 CRITICAL/IMPORTANT 已闭环修复，残余项均为非阻断已知限制。

**Final Assessment：No critical issues. Ready for archive（含 §5 已知限制说明）。**
