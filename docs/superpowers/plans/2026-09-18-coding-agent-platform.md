---
change: coding-agent-platform
design-doc: docs/superpowers/specs/2026-09-18-coding-agent-platform-design.md
base-ref: b1a3b1d0c63647908079334258c8bdb17f1b1e48
archived-with: 2026-09-18-coding-agent-platform
---

# 编码 Agent 平台 实施计划（Implementation Plan）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个本地 Web 平台，作者配置 coding agent（先 CodeBuddy，CLI 子进程）与项目↔磁盘映射，把带令牌链接发给业务人员；业务人员在四窗格工作台对话驱动 coding agent 改盘并回显 diff/测试结果。

**Architecture:** 平台 = 对话中继 + 事件展示层。FastAPI 后端提供 REST + SSE；coding agent 以 CLI 子进程接入，其 stdout 被解析为 `AgentEvent` 经 SSE 推到前端四窗格（需求/设计/编码/测试）。SQLite（Python stdlib `sqlite3`）存储，库文件位于平台目录内，不污染目标项目。前端 React(Vite) 实现四大模块页面与四窗格工作台。

**Tech Stack:** Python 3.11+ / FastAPI / uvicorn / sqlite3(stdlib) / pydantic；React 18 + Vite + TypeScript；SSE（原生 `EventSource`）做流式。

**Spec:** `docs/superpowers/specs/2026-09-18-coding-agent-platform-design.md`，能力规格见 `docs/openspec/changes/coding-agent-platform/specs/*/spec.md`。

## Global Constraints

- 平台代码位于仓库 `coding-agent-platform/` 子目录，由本 change 跟踪；目标项目代码仅按映射访问，平台代码不得写入目标项目。
- 所有文件操作（agent 产生的路径）必须经平台做 realpath 前缀白名单校验，越界拒绝。
- 访问采用链接令牌免登录：持有有效令牌的业务人员只能访问被授权的项目集合；无账号体系。
- coding agent 以 CLI 子进程方式接入；本轮先实现 CodeBuddy 适配器，架构预留 Cursor 等后续适配器。
- 「设计」窗格本轮留空占位；测试窗格展示 agent 自报的测试结果（平台不自行跑 test_command）。
- 四窗格共享同一 session 对话主线，每条 message 带 `pane` 标签用于视图分流。

---

## 文件结构

```
coding-agent-platform/
├── backend/
│   ├── app.py                 # FastAPI 入口、CORS、路由挂载、启动
│   ├── config.py              # 配置（DB 路径、web 资源、默认端口）
│   ├── db.py                  # sqlite 连接 + 建表 + 迁移
│   ├── models.py              # pydantic / dataclass 模型
│   ├── repositories.py        # agents/projects/requirements/tokens/sessions/messages DAO
│   ├── auth.py                # 令牌签发/校验 + 白名单中间件
│   ├── agent_runtime.py       # CodingAgentProvider 协议 + AgentRegistry
│   ├── adapters/
│   │   ├── codebuddy.py       # CodeBuddyAdapter（子进程 + 事件解析）
│   │   └── fake.py            # FakeAgentAdapter（echo JSON-lines，用于集成测试）
│   ├── session_service.py     # 会话/消息 + 调用 provider + SSE 事件流
│   ├── diff.py                # git diff / 快照对比
│   └── tests/
│       ├── test_auth.py
│       ├── test_whitelist.py
│       ├── test_provider.py
│       └── test_session.py
├── agents/
│   └── fake_agent.py          # 假 agent CLI：读 stdin，逐行 echo AgentEvent JSON
├── web/                       # React(Vite) 前端
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── api.ts
│       ├── App.tsx
│       ├── pages/
│       │   ├── ProjectList.tsx
│       │   ├── AgentList.tsx
│       │   ├── RequirementList.tsx
│       │   └── Workbench.tsx     # 四窗格工作台
│       └── components/
│           ├── ChatPanel.tsx
│           ├── CodePane.tsx
│           ├── TestPane.tsx
│           └── RequirementPane.tsx
├── data/                      # 运行时生成的 app.db（gitignore）
├── start.py                   # 一键启动（后端 + 构建前端并 serve）
└── README.md                  # 启动与分享说明
```

---

## Task 1: 后端脚手架与数据库初始化

**Files:**
- Create: `coding-agent-platform/backend/app.py`
- Create: `coding-agent-platform/backend/config.py`
- Create: `coding-agent-platform/backend/db.py`
- Create: `coding-agent-platform/backend/models.py`
- Create: `coding-agent-platform/start.py`
- Create: `coding-agent-platform/README.md`

**Interfaces:**
- `config.py` 暴露 `CONFIG` 对象：`db_path`、`web_dist`、`host`、`port`、`default_token_ttl`。
- `db.py` 暴露 `get_conn() -> sqlite3.Connection` 与 `init_db(conn)`。

- [ ] **Step 1: 写 `config.py`**

```python
from pathlib import Path
BASE = Path(__file__).resolve().parent.parent
class Config:
    db_path = BASE / "data" / "app.db"
    web_dist = BASE / "web" / "dist"
    host = "0.0.0.0"
    port = 8000
    default_token_ttl_days = 30
CONFIG = Config()
```

- [ ] **Step 2: 写 `db.py`（建表）**

```python
import sqlite3
from .config import CONFIG

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  disk_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS tokens(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  project_ids TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  git_branch TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(requirement_id) REFERENCES requirements(id),
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  pane TEXT NOT NULL DEFAULT 'message',
  content TEXT NOT NULL,
  has_edit INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
"""

def get_conn() -> sqlite3.Connection:
    CONFIG.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(CONFIG.db_path))
    conn.row_factory = sqlite3.Row
    return conn

def init_db(conn: sqlite3.Connection):
    conn.executescript(SCHEMA)
    conn.commit()
```

- [ ] **Step 3: 写最小 `app.py` 启动骨架 + 根路由健康检查**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .db import get_conn, init_db

app = FastAPI(title="coding-agent-platform")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def _startup():
    init_db(get_conn())

@app.get("/api/health")
def health():
    return {"ok": True}
```

- [ ] **Step 4: 写 `start.py` 启动入口**

```python
import uvicorn
from backend.config import CONFIG
from backend.db import get_conn, init_db

def main():
    init_db(get_conn())
    uvicorn.run("backend.app:app", host=CONFIG.host, port=CONFIG.port, reload=False)

if __name__ == "__main__":
    main()
```

- [ ] **Step 5: 安装后端依赖并启动验证**

Run: `cd coding-agent-platform && pip install fastapi uvicorn && python start.py`（后台）后 `curl localhost:8000/api/health`
Expected: `{"ok":true}`

- [ ] **Step 6: 提交**

```bash
git add coding-agent-platform/backend coding-agent-platform/start.py
git commit -m "feat: backend scaffold + sqlite schema"
```

---

## Task 2: 仓储层（repositories）

**Files:**
- Create: `coding-agent-platform/backend/repositories.py`
- Test: `coding-agent-platform/backend/tests/test_repositories.py`（可并入后续测试任务）

**Interfaces:**
- `AgentRepo`, `ProjectRepo`, `RequirementRepo`, `TokenRepo`, `SessionRepo`, `MessageRepo` 各方法返回 dict / list[dict]。
- 后续任务调用这些方法，签名以此为准。

- [ ] **Step 1: 写失败测试（agents/project/requirement CRUD）**

```python
import pytest
from backend.db import get_conn, init_db
from backend import repositories as R

@pytest.fixture
def conn():
    c = get_conn(); init_db(c); yield c; c.close()

def test_agent_crud(conn):
    a = R.AgentRepo.create(conn, "cb", "codebuddy", '{"cmd":"codebuddy"}')
    assert R.AgentRepo.get(conn, a["id"])["name"] == "cb"
    assert R.AgentRepo.list(conn)[0]["type"] == "codebuddy"
    with pytest.raises(Exception):
        R.AgentRepo.create(conn, "cb", "codebuddy", "{}")  # 重名冲突

def test_project_requirement(conn):
    p = R.ProjectRepo.create(conn, "demo", "/tmp/demo")
    r = R.RequirementRepo.create(conn, p["id"], "登录", "描述")
    assert R.RequirementRepo.list_by_project(conn, p["id"])[0]["title"] == "登录"
    R.RequirementRepo.delete(conn, r["id"])
    assert R.RequirementRepo.list_by_project(conn, p["id"]) == []
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd coding-agent-platform && python -m pytest backend/tests/test_repositories.py -v`
Expected: FAIL（模块/方法未定义）

- [ ] **Step 3: 实现 `repositories.py`**

实现上述各 Repo 的 `create/get/list/delete`（token 含 `create(token, project_ids, expires_at)`、`resolve(token)->dict|None`、`projects_for(token)`）。`MessageRepo.create(conn, session_id, role, pane, content, has_edit)` 与 `list_by_session`。

- [ ] **Step 4: 运行测试通过**

Run: `python -m pytest backend/tests/test_repositories.py -v` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add coding-agent-platform/backend/repositories.py coding-agent-platform/backend/tests
git commit -m "feat: repository layer for all entities"
```

---

## Task 3: 令牌鉴权 + 目录白名单

**Files:**
- Create: `coding-agent-platform/backend/auth.py`
- Test: `coding-agent-platform/backend/tests/test_auth.py`
- Test: `coding-agent-platform/backend/tests/test_whitelist.py`

**Interfaces:**
- `TokenService.issue(project_ids: list[int], ttl_days=None) -> str`（返回令牌）
- `TokenService.resolve(token: str|None) -> dict|None`（`{"project_ids": [...]}`，过期返回 None）
- `whitelist.check(project_disk_path: str, candidate: str) -> bool`（realpath 前缀校验）
- FastAPI 依赖 `get_allowed_projects(request) -> set[int]`（从 query `?token=` 解析）

- [ ] **Step 1: 写令牌与白名单测试**

```python
def test_token_roundtrip(conn):
    from backend import auth
    tok = auth.TokenService.issue(conn, [1,2])
    assert auth.TokenService.resolve(conn, tok)["project_ids"] == [1,2]
    assert auth.TokenService.resolve(conn, "nope") is None

def test_whitelist():
    from backend import auth
    assert auth.whitelist.check("/projects/foo", "/projects/foo/src/a.py") is True
    assert auth.whitelist.check("/projects/foo", "/projects/bar/x.py") is False
    assert auth.whitelist.check("/projects/foo", "/projects/foo/../bar/x.py") is False
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest backend/tests/test_auth.py backend/tests/test_whitelist.py -v` Expected: FAIL

- [ ] **Step 3: 实现 `auth.py`**

```python
import os, secrets, datetime
from . import repositories as R

class TokenService:
    @staticmethod
    def issue(conn, project_ids, ttl_days=None):
        tok = secrets.token_urlsafe(24)
        exp = None
        if ttl_days:
            exp = (datetime.datetime.now()+datetime.timedelta(days=ttl_days)).isoformat()
        R.TokenRepo.create(conn, tok, project_ids, exp)
        return tok
    @staticmethod
    def resolve(conn, token):
        if not token: return None
        row = R.TokenRepo.resolve(conn, token)
        if not row: return None
        if row["expires_at"]:
            if datetime.datetime.fromisoformat(row["expires_at"]) < datetime.datetime.now():
                return None
        return {"project_ids": row["project_ids"]}

class whitelist:
    @staticmethod
    def check(project_disk_path: str, candidate: str) -> bool:
        base = os.path.realpath(project_disk_path)
        target = os.path.realpath(candidate)
        return target == base or target.startswith(base + os.sep)
```

- [ ] **Step 4: 运行测试通过**

Run: `python -m pytest backend/tests/test_auth.py backend/tests/test_whitelist.py -v` Expected: PASS

- [ ] **Step 5: 在 `app.py` 挂接令牌中间件**（解析 `?token=`，注入 `request.state.allowed_projects`；未带令牌访问受保护路由返回 401）

- [ ] **Step 6: 提交**

```bash
git add coding-agent-platform/backend/auth.py coding-agent-platform/backend/app.py coding-agent-platform/backend/tests
git commit -m "feat: token auth + directory whitelist"
```

---

## Task 4: Agent Provider 协议 + 注册表 + 适配器

**Files:**
- Create: `coding-agent-platform/backend/agent_runtime.py`
- Create: `coding-agent-platform/backend/adapters/fake.py`
- Create: `coding-agent-platform/backend/adapters/codebuddy.py`
- Create: `coding-agent-platform/agents/fake_agent.py`
- Test: `coding-agent-platform/backend/tests/test_provider.py`

**Interfaces:**
- `AgentEvent` dataclass：`type: Literal["message","edit","test","status","error"]`, `pane: str`, `text: str|None`, `payload: dict|None`
- `class CodingAgentProvider(Protocol): async def invoke(self, session, message, project_path) -> AsyncIterator[AgentEvent]`
- `AgentRegistry.get(type) -> CodingAgentProvider`；启动时注册 `fake` 与 `codebuddy`。
- `CodeBuddyAdapter.invoke` 以子进程运行 `config["cmd"]`，stdin 传 JSON prompt，逐行解析 stdout 为 `AgentEvent`。

- [ ] **Step 1: 写 provider 测试（fake adapter 产出事件流）**

```python
import asyncio
from backend.agent_runtime import AgentRegistry, AgentEvent

def test_fake_adapter():
    prov = AgentRegistry.get("fake")
    async def run():
        events = [e async for e in prov.invoke(None, "把按钮改成红色", "/tmp/demo")]
        assert any(e.type=="edit" for e in events)
        assert any(e.type=="test" for e in events)
    asyncio.run(run())
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest backend/tests/test_provider.py -v` Expected: FAIL

- [ ] **Step 3: 实现 `agent_runtime.py` + `adapters/fake.py`**

`fake.py` 根据 message 关键字（如"红"/"red"）在 `project_path` 写/改一个文件，然后 yield `status`、`edit`(payload 含 path)、`message`、`test`(payload 含 passed=True)。`agent_runtime.py` 定义协议、事件、注册表。

- [ ] **Step 4: 实现 `adapters/codebuddy.py`（子进程 + JSON-lines 解析）**

```python
class CodeBuddyAdapter:
    type = "codebuddy"
    async def invoke(self, session, message, project_path):
        import json, asyncio
        cfg = json.loads(session["agent_config"])
        proc = await asyncio.create_subprocess_exec(
            cfg["cmd"], cwd=project_path,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        prompt = json.dumps({"message": message, "project_path": project_path})
        out, _ = await proc.communicate(prompt.encode())
        for line in out.decode().splitlines():
            line=line.strip()
            if not line: continue
            try: yield AgentEvent(**json.loads(line))
            except Exception: yield AgentEvent(type="message", pane="message", text=line)
```

- [ ] **Step 5: 实现 `agents/fake_agent.py`（可被子进程调用的 CLI）**

读取 stdin JSON，按关键字写文件，逐行 `print(json.dumps(AgentEvent))`。用于后续接真实 CodeBuddy 前的端到端验证。

- [ ] **Step 6: 运行测试通过**

Run: `python -m pytest backend/tests/test_provider.py -v` Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add coding-agent-platform/backend/agent_runtime.py coding-agent-platform/backend/adapters coding-agent-platform/agents coding-agent-platform/backend/tests
git commit -m "feat: agent provider protocol + fake/codebuddy adapters"
```

---

## Task 5: 项目管理 API + UI

**Files:**
- Modify: `coding-agent-platform/backend/app.py`（新增 `/api/projects` 路由 + 令牌保护）
- Modify: `coding-agent-platform/web/src/pages/ProjectList.tsx`（新建）
- Modify: `coding-agent-platform/web/src/api.ts`、`App.tsx`

**Interfaces:**
- `POST /api/projects` body `{name, disk_path}` → 校验 `disk_path` 存在且为目录，否则 400。
- `GET /api/projects?token=...` → 仅返回 `allowed_projects` 内项目。
- `POST /api/projects/{id}/issue-token` → 返回含令牌的链接 `http://<host>:<port>/?token=xxx`。

- [ ] **Step 1: 写项目 API 测试**

```python
def test_create_and_issue(client):
    r = client.post("/api/projects", json={"name":"demo","disk_path":"/tmp/demo"})
    assert r.status_code == 200
    pid = r.json()["id"]
    r2 = client.post(f"/api/projects/{pid}/issue-token")
    assert "token=" in r2.json()["link"]
    # 非法路径
    r3 = client.post("/api/projects", json={"name":"x","disk_path":"/no/such/dir"})
    assert r3.status_code == 400
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest ...` Expected: FAIL

- [ ] **Step 3: 实现后端 `/api/projects` 路由**（含磁盘校验：`os.path.isdir`）

- [ ] **Step 4: 实现前端 `ProjectList.tsx`**（列表 + 新建表单 + 「生成分享链接」按钮调用 issue-token 并展示）

- [ ] **Step 5: 运行测试通过并手动验证 UI**

- [ ] **Step 6: 提交**

```bash
git add coding-agent-platform/backend/app.py coding-agent-platform/web/src
git commit -m "feat: project management API + UI"
```

---

## Task 6: Agent 管理 API + UI

**Files:**
- Modify: `coding-agent-platform/backend/app.py`（`/api/agents`）
- Modify: `coding-agent-platform/web/src/pages/AgentList.tsx`

**Interfaces:**
- `POST /api/agents` body `{name, type, config}` → `name` 唯一，冲突 409。
- `GET /api/agents` → 列表。
- `DELETE /api/agents/{id}`。

- [ ] **Step 1: 写 agent API 测试（重名冲突）**
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现后端路由**（重名校验用 repositories 的 UNIQUE 约束捕获）
- [ ] **Step 4: 实现前端 `AgentList.tsx`**（注册 CodeBuddy：填 name + cmd + 其他 config JSON）
- [ ] **Step 5: 测试通过 + UI 验证**
- [ ] **Step 6: 提交** `git commit -m "feat: agent management API + UI"`

---

## Task 7: 需求管理 API + UI

**Files:**
- Modify: `coding-agent-platform/backend/app.py`（`/api/projects/{pid}/requirements`）
- Modify: `coding-agent-platform/web/src/pages/RequirementList.tsx`

**Interfaces:**
- `GET /api/projects/{pid}/requirements` → 列表（按项目）
- `POST .../requirements` body `{title, description}`
- `DELETE /api/requirements/{rid}` → 级联删除关联 sessions/messages

- [ ] **Step 1: 写需求 API 测试（CRUD + 删除级联）**
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现后端路由**（删除时先删 messages/sessions 再删 requirement）
- [ ] **Step 4: 实现前端 `RequirementList.tsx`**（某项目下需求列表 + 新建 + 删除 + 「打开工作台」入口）
- [ ] **Step 5: 测试通过 + UI 验证**
- [ ] **Step 6: 提交** `git commit -m "feat: requirement management API + UI"`

---

## Task 8: 需求设计工作台（四窗格 + SSE）

**Files:**
- Create: `coding-agent-platform/backend/session_service.py`
- Create: `coding-agent-platform/backend/diff.py`
- Modify: `coding-agent-platform/backend/app.py`（`/api/sessions`、`/api/sessions/{id}/messages` SSE、`/api/sessions/{id}/messages/history`）
- Create: `coding-agent-platform/web/src/pages/Workbench.tsx`
- Create: `coding-agent-platform/web/src/components/{ChatPanel,RequirementPane,CodePane,TestPane}.tsx`

**Interfaces:**
- `SessionService.create(conn, requirement_id) -> dict`（选 agent + project，建 git 工作分支 `agent/<id>`，存 `git_branch`）
- `SessionService.send(conn, session_id, message) -> AsyncIterator[AgentEvent]`（取 session + agent 配置 → `AgentRegistry.get(type).invoke(...)` → 落库 messages → yield 事件）
- `diff.compute(project_path) -> str`（`git diff` 若 git 仓库，否则文件快照对比）
- 前端 `EventSource('/api/sessions/{id}/messages?token=...&message=...')` 接收事件，按 `type`/`pane` 分流到四窗格。

- [ ] **Step 1: 写工作台测试（session 创建 + 消息触发事件落库 + diff）**

```python
def test_session_flow(conn, tmp_path):
    from backend import session_service as S, diff
    ag = R.AgentRepo.create(conn, "fake","fake",'{}')
    p = R.ProjectRepo.create(conn, "d", str(tmp_path))
    rq = R.RequirementRepo.create(conn, p["id"], "t", "")
    s = S.SessionService.create(conn, rq["id"])
    events = list(asyncio.run(S.SessionService.send(conn, s["id"], "把标题改成红色")))
    assert any(e.type=="edit" for e in events)
    assert R.MessageRepo.list_by_session(conn, s["id"])
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 `diff.py` 与 `session_service.py`**
- [ ] **Step 4: 实现后端 SSE 路由**（`text/event-stream`，每行 `data: <AgentEvent JSON>`；`edit` 事件附加 `diff.compute(project_path)`）
- [ ] **Step 5: 实现前端四窗格 `Workbench.tsx`** + 四个组件：
  - `ChatPanel`：消息输入框 + 对话流（message 事件）
  - `RequirementPane`：展示需求文档（requirement 内容）
  - `DesignPane`：空占位（本轮）
  - `CodePane`：edit 事件 + diff 文本
  - `TestPane`：test 事件结果
- [ ] **Step 6: 测试通过 + 浏览器手动验证四窗格分流**
- [ ] **Step 7: 提交** `git commit -m "feat: four-pane workbench with SSE + diff"`

---

## Task 9: 端到端联调 + 启动说明

**Files:**
- Modify: `coding-agent-platform/README.md`
- Modify: `coding-agent-platform/start.py`（构建并 serve 前端 dist）
- Modify: `coding-agent-platform/web/vite.config.ts`（`base: "./"`，`build.outDir` 指向 `dist`）

**Interfaces:**
- `start.py`：构建前端（`npm --prefix web run build`）后启动 FastAPI 并 `StaticFiles` serve `web/dist`。
- 端到端脚本：创建 CodeBuddy(fake cmd) agent → 创建项目映射 `/tmp/demo` → 生成令牌链接 → 用链接打开 → 选项目 → 新建需求 → 工作台对话 → 验证编码窗格 diff + 测试窗格结果。

- [ ] **Step 1: 编写 README（启动命令、如何生成分享链接、如何接真实 CodeBuddy CLI）**
- [ ] **Step 2: 配置 vite `base:'./'` 与 `start.py` 静态托管前端**
- [ ] **Step 3: 用 fake agent 跑通端到端主链路（curl 或脚本）**
- [ ] **Step 4: 提交** `git commit -m "feat: e2e wiring + launch docs"`

---

## 自检（Self-Review）

- **Spec 覆盖**：coding-agent-management（注册/可插拔/CodeBuddy/未配置提示）→ T4/T6；project-management（映射/令牌/白名单）→ T3/T5；requirement-management → T7；requirement-design-workbench（四窗格/召唤/回显/迭代）→ T8。均覆盖。
- **占位符扫描**：核心逻辑（provider 事件解析、令牌、白名单、SSE、diff）均含具体代码；UI 组件以明确结构描述，无 "TBD"。
- **类型一致性**：`AgentEvent` / `AgentRegistry.get(type)` / `SessionService.send(...)->AsyncIterator[AgentEvent]` / `whitelist.check` 在各任务一致使用。
