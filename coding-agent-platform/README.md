# 编码 Agent 平台（coding-agent-platform）

本地启动一个 Web 平台，把带令牌的链接发给业务人员；业务人员进入后只能看到被预授权的项目，在
**需求 / 设计 / 编码 / 测试** 四窗格工作台中通过对话召唤 coding agent，直接修改映射目录下的项目代码，
并实时回显 diff 与测试结果，直到满足业务需求。

## 核心特性

- **可插拔执行引擎**：`CodingAgentProvider` 协议 + `AgentRegistry`，先支持 `fake`（联调）与
  `codebuddy`（子进程调用 CodeBuddy CLI）两类适配器，后续可扩展 Cursor 等。
- **链接令牌免登录**：业务人员持 `?token=` 链接进入，无需账号体系；后端按令牌白名单过滤可见项目，
  目录访问做 `realpath` 前缀校验。
- **四窗格工作台**：需求（对话主线）/ 设计（占位）/ 编码（diff）/ 测试（agent 自报结果）。
- **SSE 实时回显**：对话通过 `EventSource` 流式接收 `AgentEvent`，按 `type`/`pane` 分流到对应窗格。
- **改动可见**：编码事件附 `git diff`（优先 git，非 git 仓库给出提示）；会话在 git 仓库中自动建工作分支隔离。

## 目录结构

```
coding-agent-platform/
├── backend/                 # FastAPI + stdlib（sqlite3 / pydantic / SSE）
│   ├── app.py               # 路由、令牌依赖、SSE、静态托管
│   ├── config.py            # 路径/端口配置
│   ├── db.py / models.py / repositories.py / auth.py
│   ├── agent_runtime.py     # AgentEvent / Provider 协议 / 注册表
│   ├── adapters/            # fake.py、codebuddy.py
│   ├── session_service.py   # 会话创建(git 分支) + 调用 agent + 落库
│   ├── diff.py              # git diff 计算
│   └── tests/               # 无 pytest 运行的测试套件（run_all.py）
├── web/                     # React 18 + Vite + TypeScript
│   └── src/
│       ├── api.ts / auth.ts / App.tsx
│       ├── pages/           # ProjectList / RequirementList / Workbench / AgentList
│       └── components/      # RequirementPane / CodePane / TestPane / ChatPanel
├── agents/fake_agent.py     # 假 agent CLI（供 codebuddy 适配器对接联调）
├── start.py                 # 一键启动入口
└── requirements.txt
```

## 环境准备

> 本仓库在**无外网**的构建环境中产出：Python 核心逻辑已用标准库实测，前端代码完整实现但未在本机
> `npm install` 构建。请在**有网的本机**执行下面的安装步骤。

- Python 3.11+（建议用虚拟环境）
- Node.js 18+ 与 npm

## 安装与启动

```bash
# 1) 后端依赖
cd coding-agent-platform
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 2) 前端构建（产物输出到 web/dist，由后端以静态文件托管）
cd web
npm install
npm run build
cd ..

# 3) 启动（默认 http://0.0.0.0:8000）
python start.py
```

开发模式（热更新）可分开跑：

```bash
# 终端 A：后端
python start.py
# 终端 B：前端（Vite 默认 5173，已配置 /api 代理到 8000）
cd web && npm run dev
```

## 配置 Coding Agent

1. 打开 `Agent 管理` 页（路由 `/#/agents`）。
2. 添加 `fake` agent（联调用，config 填 `{}`）。
3. 接真实 CodeBuddy：添加 `codebuddy` agent，config 填
   `{"cmd":"codebuddy","args":[]}`（确保 `codebuddy` 在 PATH，或写绝对路径）。

## 使用流程

1. `Agent 管理` 至少注册 1 个 agent。
2. `项目` 页添加项目，填写**本地磁盘绝对路径**（目录需真实存在）。
3. 项目卡片点 `生成分享链接`，复制形如 `http://<host>:8000/?token=xxxx` 的链接发给业务人员。
4. 业务人员打开链接 → 进入 `项目` → 点 `需求` → `添加需求` → `进入工作台`。
5. 在**需求**窗格描述诉求并发送，agent 产生的改动（编码窗格 diff）与测试结果（测试窗格）实时回显。

## 接真实 CodeBuddy CLI 的约定

`codebuddy` 适配器以子进程方式启动 CLI：

- 通过 **stdin** 传入 JSON：`{"message": "...", "project_path": "..."}`
- **stdout** 每行一个 `AgentEvent` JSON（JSON-lines）；非 JSON 行回退为 `message` 事件。
  事件字段：`{"type":"message|edit|test|status|error", "pane":"message|code|test", "text":"...", "payload":{...}}`
- 编码事件 `pane:"code"` 会触发平台计算 `git diff` 并展示；测试事件 `pane:"test"` 建议带
  `payload:{"cmd":"...","passed":true,"output":"..."}`。

## 已知限制（MVP）

- diff 仅在事件流中实时计算，**不落库**；刷新工作台后编码/测试窗格的历史以文本形式还原，diff 不保留。
- 设计窗格为占位（按既定决策暂留空）。
- `/api/projects/{pid}/issue-token` 当前未校验调用方身份（内部工具假设管理员操作）。
- 平台定位为「对话中继 + 事件展示层」：是否编码、如何测试由 agent CLI 自行判断，平台不内置编码按钮。

## 测试

```bash
python backend/tests/run_all.py
```

覆盖令牌签发/校验、目录白名单、适配器、仓储 CRUD、会话调用 fake agent 落库等，预期 `6/6 passed`。
HTTP 路由层（FastAPI）需 `pip install` 后在完整环境下验证。
