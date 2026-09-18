"""FastAPI 应用：路由、令牌依赖、SSE 事件流、前端静态托管。"""
import json
import os
import sqlite3
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from .db import get_conn, init_db
from . import repositories as R
from . import auth
from . import session_service as S
from . import diff as D
from .models import AgentCreate, ProjectCreate, RequirementCreate, TokenIssue
from .agent_runtime import AgentRegistry
from .adapters.fake import FakeAgentAdapter
from .adapters.codebuddy import CodeBuddyAdapter

app = FastAPI(title="coding-agent-platform")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def _startup():
    init_db(get_conn())
    AgentRegistry.register("fake", FakeAgentAdapter())
    AgentRegistry.register("codebuddy", CodeBuddyAdapter())


def get_db():
    conn = get_conn()
    try:
        yield conn
    finally:
        conn.close()


def get_allowed(db: sqlite3.Connection = Depends(get_db), token: str = Query(None)):
    row = auth.TokenService.resolve(db, token)
    if row is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    return set(row["project_ids"])


# ---------------- Agent 管理 ----------------

@app.post("/api/agents")
def create_agent(body: AgentCreate, db: sqlite3.Connection = Depends(get_db)):
    try:
        return R.AgentRepo.create(db, body.name, body.type, body.config)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"agent 名称已存在: {body.name}")


@app.get("/api/agents")
def list_agents(db: sqlite3.Connection = Depends(get_db)):
    return R.AgentRepo.list(db)


@app.delete("/api/agents/{aid}")
def delete_agent(aid: int, db: sqlite3.Connection = Depends(get_db)):
    R.AgentRepo.delete(db, aid)
    return {"ok": True}


# ---------------- 项目管理 ----------------

@app.post("/api/projects")
def create_project(body: ProjectCreate, db: sqlite3.Connection = Depends(get_db)):
    if not os.path.isdir(body.disk_path):
        raise HTTPException(status_code=400, detail=f"磁盘路径不存在或不是目录: {body.disk_path}")
    return R.ProjectRepo.create(db, body.name, body.disk_path)


@app.get("/api/projects")
def list_projects(allowed: set = Depends(get_allowed), db: sqlite3.Connection = Depends(get_db)):
    return R.ProjectRepo.list(db, allowed_ids=list(allowed))


@app.post("/api/projects/{pid}/issue-token")
def issue_token(pid: int, body: TokenIssue | None = None,
                db: sqlite3.Connection = Depends(get_db), request: Request = None):
    ids = body.project_ids if body and body.project_ids else [pid]
    tok = auth.TokenService.issue(db, ids, (body.ttl_days if body else None))
    base = str(request.base_url).rstrip("/") if request else "http://localhost:8000"
    link = f"{base}/?token={tok}"
    return {"token": tok, "link": link}


@app.delete("/api/projects/{pid}")
def delete_project(pid: int, db: sqlite3.Connection = Depends(get_db)):
    R.ProjectRepo.delete(db, pid)
    return {"ok": True}


# ---------------- 需求管理 ----------------

@app.get("/api/projects/{pid}/requirements")
def list_requirements(pid: int, allowed: set = Depends(get_allowed),
                      db: sqlite3.Connection = Depends(get_db)):
    if pid not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    return R.RequirementRepo.list_by_project(db, pid)


@app.post("/api/projects/{pid}/requirements")
def create_requirement(pid: int, body: RequirementCreate,
                       allowed: set = Depends(get_allowed),
                       db: sqlite3.Connection = Depends(get_db)):
    if pid not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    return R.RequirementRepo.create(db, pid, body.title, body.description)


@app.delete("/api/requirements/{rid}")
def delete_requirement(rid: int, db: sqlite3.Connection = Depends(get_db)):
    R.RequirementRepo.delete(db, rid)
    return {"ok": True}


# ---------------- 需求设计工作台 ----------------

@app.post("/api/sessions")
def create_session(body: dict, db: sqlite3.Connection = Depends(get_db), token: str = Query(None)):
    row = auth.TokenService.resolve(db, token)
    if row is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    rid = body.get("requirement_id")
    if rid is None:
        raise HTTPException(status_code=400, detail="缺少 requirement_id")
    req = R.RequirementRepo.get(db, rid)
    if req is None:
        raise HTTPException(status_code=400, detail="需求不存在")
    if req["project_id"] not in set(row["project_ids"]):
        raise HTTPException(status_code=403, detail="无权访问该项目")
    try:
        return S.SessionService.create(db, rid)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/sessions/{sid}/messages")
def session_history(sid: int, db: sqlite3.Connection = Depends(get_db), token: str = Query(None)):
    row = auth.TokenService.resolve(db, token)
    if row is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    sess = R.SessionRepo.get(db, sid)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess["project_id"] not in set(row["project_ids"]):
        raise HTTPException(status_code=403, detail="无权访问该项目")
    return R.MessageRepo.list_by_session(db, sid)


@app.get("/api/sessions/{sid}/events")
async def stream_events(
    sid: int,
    message: str = Query(...),
    token: str = Query(None),
):
    """SSE：按 message 触发（或续传）agent 处理，流式返回 AgentEvent；edit 事件含 git diff。

    幂等保证（与浏览器 SSE 自动重连、断线续传配合）：
    - 同一 (sid, message) 复用同一 run；run 在后台执行，断线不杀死 agent，重连订阅同一流，
      不会重复调 agent（避免重复改盘/落库）。
    - 已完成运行的重连从 DB 回放，亦不重复调 agent。
    - 令牌与项目权限在该连接的每一请求上校验。
    """
    async def gen():
        conn = get_conn()
        try:
            row = auth.TokenService.resolve(conn, token)
            if row is None:
                async for y in _sse_error("无效或缺失访问令牌"):
                    yield y
                return
            sess = R.SessionRepo.get(conn, sid)
            if sess is None:
                async for y in _sse_error("会话不存在"):
                    yield y
                return
            if sess["project_id"] not in set(row["project_ids"]):
                async for y in _sse_error("无权访问该项目"):
                    yield y
                return
            proj = R.ProjectRepo.get(conn, sess["project_id"])
            mode, run_id = S.SessionService.resolve_run(conn, sid, message)
        finally:
            conn.close()

        if mode == "replay":
            conn2 = get_conn()
            try:
                msgs = R.MessageRepo.list_by_session(conn2, sid)
                last_user_idx = max((i for i, m in enumerate(msgs) if m["role"] == "user"), default=-1)
                for m in msgs[last_user_idx + 1:]:
                    if m["role"] != "agent":
                        continue
                    if m["pane"] == "code":
                        d = {"type": "edit", "pane": "code", "text": m["content"],
                             "diff": (D.compute(proj["disk_path"]) if proj else "(关联项目已删除)")}
                    elif m["pane"] == "test":
                        d = {"type": "test", "pane": "test", "text": m["content"]}
                    else:
                        d = {"type": "message", "pane": m["pane"], "text": m["content"]}
                    yield f"data: {json.dumps(d, ensure_ascii=False)}\n\n"
            finally:
                conn2.close()
            yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"
            return

        # live / new：订阅后台 run 的实时流（payload 已含 diff，无需重算）
        async for ev in S.SessionService.stream_run(run_id):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


async def _sse_error(text):
    """错误事件后追加 done，使客户端及时关闭流（避免 EventSource 自动重连空转）。"""
    yield f"data: {json.dumps({'type': 'error', 'text': text}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"


# ---------------- 前端静态托管（若存在构建产物） ----------------

def _mount_web():
    from .config import CONFIG
    if CONFIG.web_dist.is_dir():
        app.mount("/", StaticFiles(directory=str(CONFIG.web_dist), html=True), name="web")


_mount_web()
