"""FastAPI 应用：路由、令牌依赖、SSE 事件流、前端静态托管。"""
import asyncio
import datetime
import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .db import get_conn, init_db
from . import repositories as R
from . import auth
from . import audit
from . import logbus as LOG
from . import session_service as S
from . import diff as D
from . import docs as WD
from . import files as FS
from . import snapshots as SN
from . import test_report as TR
from . import acceptance as ACC
from . import scripts as SCR
from .config import public_share_base
from .models import (AgentCreate, AgentUpdate, AgentReorderIn, AgentTestIn, ProjectCreate,
                     ProjectUpdate,
                     RequirementCreate,
                     TokenIssue, AdminTokenIssue, AdminTokenUpdate,
                     FileWriteIn, FileCreateIn, FileRenameIn,
                     RequirementUpdate, StageIn, CaseIn, CaseBulkIn, CaseBatchDeleteIn, BatchIdsIn,
                     CaseUpdate,
                     ArchiveIn, AiTaskIn, ScriptSaveIn, ScriptRunIn, SessionAgentIn,
                     STAGES, CASE_STATUSES, VERDICTS)
from . import ai_tasks as AI
from .agent_runtime import AgentRegistry
from .agent_test import probe_agent
from .adapters.fake import FakeAgentAdapter
from .adapters.codebuddy import CliAgentAdapter, CLI_AGENT_TYPES

app = FastAPI(title="coding-agent-platform")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(Exception)
async def _unhandled_exception(request: Request, exc: Exception):
    """兜底异常处理：任何未捕获异常都返回结构化 JSON。

    否则 Starlette 默认回一段 text/plain 的 "Internal Server Error"，前端
    JSON 解析失败后只能弹出一个光秃秃的 “500”，用户既不知道原因也不知道怎么办。
    """
    print(f"[unhandled] {request.method} {request.url.path} -> {type(exc).__name__}: {exc}", flush=True)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "服务端内部错误",
            "hint": "请查看后端控制台日志中的 traceback；修复或重启后端后重试。",
            "error": f"{type(exc).__name__}: {exc}",
            "path": request.url.path,
        },
    )


@app.on_event("startup")
def _startup():
    init_db(get_conn())
    _migrate_workspace_layout()
    AgentRegistry.register("fake", FakeAgentAdapter())  # 联调/冒烟用，不在前端类型选项里
    for t in CLI_AGENT_TYPES:
        AgentRegistry.register(t, CliAgentAdapter(t))


def _migrate_workspace_layout():
    """老布局（.janus/docs/、.janus/attachments/rN、.janus/cases/cN、.janus/test-cases.md）
    一次性搬到按需求分目录的新布局。幂等：源文件不存在或目标已存在就跳过。

    附件搬完同步更新数据库里的 path；文档镜像只在项目只有一个需求时搬
    （多需求时分不清老镜像属于谁，留待下次保存时在新路径重新生成）。
    """
    conn = get_conn()
    try:
        atts = conn.execute(
            "SELECT a.id, a.requirement_id, a.case_id, a.path, r.dir_name "
            "FROM attachments a JOIN requirements r ON r.id = a.requirement_id"
        ).fetchall()
        if not atts:
            conn.close()
            return
        projects = {p["id"]: p["disk_path"] for p in R.ProjectRepo.list(conn)}
        rows = [dict(r) for r in atts]
        for r in rows:
            r["disk_path"] = projects.get(conn.execute(
                "SELECT project_id FROM requirements WHERE id=?", (r["requirement_id"],)
            ).fetchone()[0])
        moved = []
        by_proj: dict[str, list[dict]] = {}
        for r in rows:
            if r["disk_path"]:
                by_proj.setdefault(r["disk_path"], []).append(r)
        for disk_path, group in by_proj.items():
            moved += WD.migrate_legacy_attachments(disk_path, group)
        for aid, new_path in moved:
            conn.execute("UPDATE attachments SET path=? WHERE id=?", (new_path, aid))
        if moved:
            conn.commit()
        # 文档镜像迁移：仅单需求项目
        req_counts = conn.execute(
            "SELECT project_id, COUNT(*) AS n FROM requirements GROUP BY project_id"
        ).fetchall()
        single = {r[0] for r in req_counts if r[1] == 1}
        for r in conn.execute(
            "SELECT project_id, dir_name FROM requirements"
        ).fetchall():
            if r[0] in single and r[0] in projects:
                WD.migrate_legacy_docs(projects[r[0]], r[1])
    except Exception as e:  # noqa: BLE001
        print(f"[warn] workspace layout migration failed: {e}", flush=True)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def get_db():
    conn = get_conn()
    try:
        yield conn
    finally:
        # 收尾失败不该把已经成功的响应变成 500
        try:
            conn.close()
        except Exception as e:  # noqa: BLE001
            print(f"[warn] close conn failed: {e}", flush=True)


def _is_admin(admin: str | None) -> bool:
    """管理员口令是否有效。

    后端未配置 CAP_ADMIN_TOKEN（开放模式）时恒为 False：开放模式只放开管理端点，
    不因此放宽业务数据的访问，业务接口仍按访问令牌授权。
    """
    from .config import CONFIG
    return bool(CONFIG.admin_token) and bool(admin) and admin == CONFIG.admin_token


def resolve_access(db: sqlite3.Connection, token: str | None, admin: str | None):
    """解析本次请求可访问的项目 id 集合；凭证无效时返回 None（由调用方决定如何报错）。

    管理员口令与访问令牌是两套凭证，但管理员天然应当看得见全部项目：
    否则在管理台解锁后点进项目/需求页必然 401，因为 URL 上没有 ?token=。
    因此口令有效时直接授予全量项目，不再要求管理员额外持有访问令牌。
    """
    if _is_admin(admin):
        return {p["id"] for p in R.ProjectRepo.list(db)}
    row = auth.TokenService.resolve(db, token)
    if row is None:
        return None
    return set(row["project_ids"])


def get_allowed(db: sqlite3.Connection = Depends(get_db), token: str = Query(None),
                admin: str = Query(None)):
    allowed = resolve_access(db, token, admin)
    if allowed is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    return allowed


def require_admin(admin: str = Query(None)):
    """管理员口令校验。未配置 CAP_ADMIN_TOKEN 时保持开放（向后兼容），
    配置后所有管理类写操作与 /api/admin/* 必须携带正确的 admin 参数。"""
    from .config import CONFIG
    if not CONFIG.admin_token:
        return True
    if not _is_admin(admin):
        raise HTTPException(status_code=401, detail="无效或缺失管理员口令")
    return True


# ---------------- 操作日志上下文 ----------------
#
# 身份由 audit.RequestMiddleware 在请求进入时挂到上下文变量上，路由里直接 audit.log(...)。
# 中间件必须是纯 ASGI 实现：BaseHTTPMiddleware 会把请求包进额外的任务与内存流，
# 工作台的 SSE（agent 事件流）长连接不值得为此冒险。
app.add_middleware(audit.RequestMiddleware)


# ---------------- 令牌校验（供右上角「应用令牌」前端先验证再放行） ----------------

@app.get("/api/token/verify")
def verify_token(db: sqlite3.Connection = Depends(get_db), token: str = Query(None)):
    """校验访问令牌是否存在、未吊销、未过期。

    这是个不需要持证就能访问的公开接口，因此**只返回状态、不返回任何项目数据**，
    避免变成枚举令牌或从响应里窥探项目信息的入口。
    """
    if not token or not token.strip():
        raise HTTPException(status_code=401, detail="访问令牌不能为空")
    row = R.TokenRepo.resolve(db, token.strip())
    if row is None:
        raise HTTPException(status_code=401, detail="访问令牌不存在或已被吊销")
    exp = row.get("expires_at")
    if exp:
        try:
            if datetime.datetime.fromisoformat(exp) < datetime.datetime.now():
                raise HTTPException(status_code=401, detail="访问令牌已过期，请让管理者重新签发")
        except ValueError:
            # 过期时间脏数据当作不过期处理，避免因数据问题把合法令牌误判为失效
            pass
    return {
        "valid": True,
        "project_count": len(row.get("project_ids") or []),
        "expires_at": exp,
    }


# ---------------- Agent 管理 ----------------

# config.api_key 的掩码哨兵：列表/详情一律掩码返回（业务令牌可拉 Agent 列表，
# 明文 key 不能出后端）；编辑保存时 config.api_key 传回该值表示「保留原 key」，
# 传空串/删掉该键表示清除，传新值表示覆盖。与前端 AgentList 保持约定一致。
API_KEY_MASK = "__MASKED__"


def _config_of(agent_row: dict) -> dict:
    """把 agents.config（JSON 字符串或 dict）读成 dict，脏数据回空对象。"""
    cfg = (agent_row or {}).get("config")
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except (TypeError, ValueError):
            cfg = None
    return cfg if isinstance(cfg, dict) else {}


def _mask_config(cfg):
    """掩码 config 里的 api_key（有值时替换为哨兵），其余键原样保留。

    保持入参形态：传 JSON 字符串返回 JSON 字符串（与库里存储形态一致，
    不改变既有 API 的 config 类型），传 dict 返回 dict，脏数据回空 dict。
    """
    was_str = isinstance(cfg, str)
    if was_str:
        try:
            cfg = json.loads(cfg)
        except (TypeError, ValueError):
            cfg = None
    if isinstance(cfg, dict) and cfg.get("api_key"):
        cfg = {**cfg, "api_key": API_KEY_MASK}
    if not isinstance(cfg, dict):
        return {}
    return json.dumps(cfg, ensure_ascii=False) if was_str else cfg


def _agents_enriched(db: sqlite3.Connection) -> list[dict]:
    """Agent 列表（按调度优先级排序）+ Token 用量与可用状态。

    用量来自调用留痕（agent_invocations.total_tokens 按天汇总，仅统计今日），
    前端据此展示「今日已用 / 限额」并把超限的 Agent 标为不可用。
    config.api_key 掩码返回（见 API_KEY_MASK），另给 has_api_key 标记供前端回填。
    """
    usage = R.AgentRepo.usage_map(db)
    out = []
    for a in R.AgentRepo.list(db):
        used = usage.get(a["id"], 0)
        masked = _mask_config(a.get("config"))
        out.append({**a, "config": masked,
                    "has_api_key": bool(_config_of(a).get("api_key")),
                    "used_tokens": used,
                    "available": R.AgentRepo.is_available(a, used)})
    return out


def _validate_token_limit(value) -> int:
    """token_limit 校验：非负整数，0 表示不限额。"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="token_limit 必须是整数（0 表示不限额）")
    if n < 0:
        raise HTTPException(status_code=400, detail="token_limit 不能为负数（0 表示不限额）")
    return n


@app.post("/api/agents")
def create_agent(body: AgentCreate, db: sqlite3.Connection = Depends(get_db),
                 _ok=Depends(require_admin)):
    config = dict(body.config or {})
    # 新建时哨兵无「原值」可保留，视为未配置（防呆：编辑页逻辑被误用到新建）
    if config.get("api_key") == API_KEY_MASK:
        config.pop("api_key")
    token_limit = _validate_token_limit(body.token_limit) if body.token_limit is not None else None
    try:
        out = R.AgentRepo.create(db, body.name, body.type, config, token_limit=token_limit)
    except sqlite3.IntegrityError:
        audit.log("agent.create", status="failure", error=f"agent 名称已存在: {body.name}",
                  target_type="agent", target_name=body.name)
        raise HTTPException(status_code=409, detail=f"agent 名称已存在: {body.name}")
    audit.log("agent.create", target_type="agent", target_id=out["id"], target_name=out["name"],
              detail={"type": out["type"], "config": _mask_config(config),
                      "token_limit": out.get("token_limit")})
    # 返回与列表一致的富化视图（含用量与可用状态），前端不必二次拉取
    return next(a for a in _agents_enriched(db) if a["id"] == out["id"])


@app.get("/api/agents")
def list_agents(db: sqlite3.Connection = Depends(get_db)):
    return _agents_enriched(db)


@app.post("/api/agents/reorder")
def reorder_agents(body: AgentReorderIn, db: sqlite3.Connection = Depends(get_db),
                   _ok=Depends(require_admin)):
    """拖拽排序：ids 必须按目标顺序包含全部 Agent，一次提交完整顺序。"""
    ids = [int(i) for i in (body.ids or [])]
    existing = {a["id"] for a in R.AgentRepo.list(db)}
    if not ids or len(set(ids)) != len(ids) or set(ids) != existing:
        raise HTTPException(status_code=400,
                            detail="ids 必须按目标顺序包含全部 Agent 的 id（不重不漏）")
    R.AgentRepo.reorder(db, ids)
    audit.log("agent.reorder", target_type="agent", detail={"order": ids})
    return _agents_enriched(db)


@app.patch("/api/agents/{aid}")
def update_agent(aid: int, body: AgentUpdate, db: sqlite3.Connection = Depends(get_db),
                 _ok=Depends(require_admin)):
    """编辑 Agent 配置（名称 / 类型 / config）。

    属管理类写操作，与管理员的注册、删除同权限：管理员需要改错填的 name/type/config
    时不必先删再建（那样会连带丢掉以该 agent 建立的会话归属）。
    """
    before = R.AgentRepo.get(db, aid)
    if before is None:
        raise HTTPException(status_code=404, detail="agent 不存在")
    name = R.UNSET
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="agent 名称不能为空")
        name = body.name.strip()[:100]
    type_ = R.UNSET
    if body.type is not None:
        if not body.type.strip():
            raise HTTPException(status_code=400, detail="agent 类型不能为空")
        type_ = body.type.strip()[:50]
    # config.api_key 的哨兵语义：__MASKED__ 表示保留原 key（掩码回显后原样传回），
    # 空串/缺键表示清除，新值表示覆盖。哨兵值不能落库，这里先还原成旧值。
    config = body.config if body.config is not None else R.UNSET
    if config is not R.UNSET:
        config = dict(config or {})
        if config.get("api_key") == API_KEY_MASK:
            prev_key = _config_of(before).get("api_key")
            if isinstance(prev_key, str) and prev_key:
                config["api_key"] = prev_key
            else:
                config.pop("api_key", None)
    token_limit = _validate_token_limit(body.token_limit) if body.token_limit is not None else R.UNSET
    try:
        out = R.AgentRepo.update(
            db, aid, name=name, type_=type_,
            config=config,
            token_limit=token_limit,
        )
    except sqlite3.IntegrityError:
        audit.log("agent.update", status="failure", error=f"agent 名称已存在: {body.name}",
                  target_type="agent", target_id=aid, target_name=before["name"])
        raise HTTPException(status_code=409, detail=f"agent 名称已存在: {body.name}")
    # 只记真的变了的字段，避免「点开又保存」在日志里刷出无信息量的条目（config 掩码落审计）
    changed = {k: {"from": before[k], "to": out[k]} for k in ("name", "type", "config", "token_limit")
               if before[k] != out[k]}
    if changed:
        if "config" in changed:
            changed["config"] = {"from": _mask_config(changed["config"]["from"]),
                                 "to": _mask_config(changed["config"]["to"])}
        audit.log("agent.update", target_type="agent", target_id=aid, target_name=out["name"],
                  detail=changed)
    return next(a for a in _agents_enriched(db) if a["id"] == aid)


@app.post("/api/agents/{aid}/test")
async def test_agent(aid: int, body: AgentTestIn | None = None,
                     _ok=Depends(require_admin)):
    """一键连通性测试：向该 agent 发送探针消息（默认「你好」），返回是否可用。

    在一次性临时目录中执行，不建会话、不落库、不触碰真实项目代码。
    注意：这里自行取连接（与 SSE 端点一致）——同步 get_db 依赖会在线程池建连接，
    而 sqlite3 默认不允许跨线程使用，异步端点内再 await 会报 ProgrammingError。
    """
    conn = get_conn()
    try:
        agent = R.AgentRepo.get(conn, aid)
    finally:
        conn.close()
    if agent is None:
        raise HTTPException(status_code=404, detail="agent 不存在")
    message = (body.message if body and body.message else None) or "你好"
    timeout = body.timeout if body and body.timeout else None
    out = await probe_agent(agent, message, timeout, source="probe",
                            context={"actor": audit.actor()})
    audit.log("agent.test", status="success" if out.get("ok") else "failure",
              target_type="agent", target_id=aid, target_name=agent["name"],
              detail={"message": message, "elapsed_ms": out.get("elapsed_ms"),
                      "timed_out": out.get("timed_out")},
              error="" if out.get("ok") else (out.get("error") or ""))
    return out


@app.delete("/api/agents/{aid}")
def delete_agent(aid: int, db: sqlite3.Connection = Depends(get_db),
                 _ok=Depends(require_admin)):
    agent = R.AgentRepo.get(db, aid)
    with audit.guard("agent.delete", target_type="agent", target_id=aid,
                   target_name=(agent or {}).get("name") or ""):
        R.AgentRepo.delete(db, aid)
    audit.log("agent.delete", target_type="agent", target_id=aid,
              target_name=(agent or {}).get("name") or "")
    return {"ok": True}


# ---------------- 项目管理 ----------------

@app.post("/api/projects")
def create_project(body: ProjectCreate, db: sqlite3.Connection = Depends(get_db),
                   _ok=Depends(require_admin)):
    if not os.path.isdir(body.disk_path):
        audit.log("project.create", status="failure", target_name=body.name,
                  detail={"disk_path": body.disk_path},
                  error=f"磁盘路径不存在或不是目录: {body.disk_path}")
        raise HTTPException(status_code=400, detail=f"磁盘路径不存在或不是目录: {body.disk_path}")
    out = R.ProjectRepo.create(db, body.name, body.disk_path)
    audit.log("project.create", target_type="project", target_id=out["id"],
              target_name=out["name"], project_id=out["id"], project_name=out["name"],
              detail={"disk_path": out["disk_path"]})
    return out


@app.get("/api/projects")
def list_projects(allowed: set = Depends(get_allowed), db: sqlite3.Connection = Depends(get_db)):
    return R.ProjectRepo.list(db, allowed_ids=list(allowed))


@app.patch("/api/projects/{pid}")
@app.patch("/api/admin/projects/{pid}")
def update_project(pid: int, body: ProjectUpdate, db: sqlite3.Connection = Depends(get_db),
                   _ok=Depends(require_admin)):
    """编辑项目信息（名称 / 本地磁盘路径）。

    两个路径指向同一份实现：管理台沿用 /api/admin/* 前缀（与 admin 的增删一致），
    业务侧沿用 /api/projects/*。逻辑只有一份，避免两处校验各自漂移。

    磁盘路径改动后立即生效：后续文件面板、git diff、agent 工作目录都按新路径解析，
    因此这里与创建一样先校验目录真实存在，避免把项目改成必然报错的死路径。
    """
    before = R.ProjectRepo.get(db, pid)
    if before is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    name = R.UNSET
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="项目名称不能为空")
        name = body.name.strip()[:100]
    disk_path = R.UNSET
    if body.disk_path is not None:
        path = body.disk_path.strip()
        if not os.path.isdir(path):
            audit.log("project.update", status="failure", target_type="project", target_id=pid,
                      target_name=before["name"], project_id=pid, project_name=before["name"],
                      detail={"disk_path": path}, error=f"磁盘路径不存在或不是目录: {path}")
            raise HTTPException(status_code=400, detail=f"磁盘路径不存在或不是目录: {path}")
        disk_path = path
    out = R.ProjectRepo.update(db, pid, name=name, disk_path=disk_path)
    changed = {k: {"from": before[k], "to": out[k]} for k in ("name", "disk_path")
               if before[k] != out[k]}
    if changed:
        audit.log("project.update", target_type="project", target_id=pid, target_name=out["name"],
                  project_id=pid, project_name=out["name"], detail=changed)
    return out


@app.post("/api/projects/{pid}/issue-token")
def issue_token(pid: int, body: TokenIssue | None = None,
                db: sqlite3.Connection = Depends(get_db),
                _ok=Depends(require_admin)):
    ids = body.project_ids if body and body.project_ids else [pid]
    try:
        expires_at = auth.compute_expiry(
            body.ttl_days if body else None, body.expires_at if body else None)
    except auth.TokenExpiryError as e:
        _token_expiry_error(e)
    tok = auth.TokenService.issue(db, ids, expires_at=expires_at,
                                  note=(body.note if body else ""))
    link = f"{public_share_base()}/?token={tok}"
    # 令牌原文绝不入日志：审计要能追责，但不能变成第二个泄露口
    audit.log("token.issue", target_type="token", target_name=audit.mask_token(tok),
              project_id=pid, detail={"project_ids": ids, "expires_at": expires_at,
                                      "note": (body.note if body else "") or ""})
    return {"token": tok, "link": link, "expires_at": expires_at,
            "note": (body.note if body else "") or ""}


@app.delete("/api/projects/{pid}")
def delete_project(pid: int, db: sqlite3.Connection = Depends(get_db),
                   _ok=Depends(require_admin)):
    proj = R.ProjectRepo.get(db, pid)
    with audit.guard("project.delete", target_type="project", target_id=pid,
                   target_name=(proj or {}).get("name") or "", project_id=pid,
                   project_name=(proj or {}).get("name") or "",
                   detail={"disk_path": (proj or {}).get("disk_path")}):
        R.ProjectRepo.delete(db, pid)
    audit.log("project.delete", target_type="project", target_id=pid,
              target_name=(proj or {}).get("name") or "", project_id=pid,
              project_name=(proj or {}).get("name") or "",
              detail={"disk_path": (proj or {}).get("disk_path")})
    return {"ok": True}


# ---------------- 需求管理 ----------------

_REQ_TITLE_PREFIXED = re.compile(r"^v-\d{14}-")


def _apply_req_title_prefix(title: str) -> str:
    """新建需求统一加 v-yyyyMMddHHmmss- 前缀（业务侧要求的需求编号格式）。

    前缀取创建时刻的本地时间；标题本身已带前缀（如用户直接粘贴完整编号）则不重复加。
    """
    t = (title or "").strip()
    if _REQ_TITLE_PREFIXED.match(t):
        return t
    stamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    return f"v-{stamp}-{t}"

@app.get("/api/projects/{pid}/requirements")
def list_requirements(pid: int, allowed: set = Depends(get_allowed),
                      db: sqlite3.Connection = Depends(get_db)):
    if pid not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    return R.RequirementRepo.list_by_project(db, pid)


@app.post("/api/projects/{pid}/requirements")
def create_requirement(pid: int, body: RequirementCreate,
                       allowed: set = Depends(get_allowed),
                       db: sqlite3.Connection = Depends(get_db),
                       _ok=Depends(require_admin)):
    if pid not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    # 工作流模式：标准(full)四阶段照旧；轻量(lite)跳过澄清与用例，直接进编码实现
    mode = body.mode if body.mode in ("full", "lite") else "full"
    stage = "clarify" if mode == "full" else "build"
    title = _apply_req_title_prefix(body.title)
    # 需求目录名（.janus/{dir}/...）创建时定死，之后名称不可改 → agent 引用的路径永远有效
    dir_name = WD.unique_dir_name(db, pid, title)
    req = R.RequirementRepo.create(db, pid, title, body.description, dir_name=dir_name,
                                   mode=mode, stage=stage)
    # 建单即留一版：这样「历史版本」从空文档开始就是完整的
    R.RequirementVersionRepo.create(db, req["id"], req["title"], req["description"],
                                    source="create", note="需求创建")
    _mirror_requirement_docs(db, req, requirement=True)
    proj = R.ProjectRepo.get(db, pid)
    audit.log("requirement.create", target_type="requirement", target_id=req["id"],
              target_name=req["title"], project_id=pid,
              project_name=(proj or {}).get("name") or "",
              detail={"mode": mode})
    return req


@app.delete("/api/requirements/{rid}")
def delete_requirement(rid: int, allowed: set = Depends(get_allowed),
                       db: sqlite3.Connection = Depends(get_db),
                       _ok=Depends(require_admin)):
    # 删除需求仅管理员可操作（与新建需求一致）；业务令牌不可删。
    req = _require_requirement(db, rid, allowed)
    proj = R.ProjectRepo.get(db, req["project_id"])
    ctx = {"target_type": "requirement", "target_id": rid, "target_name": req["title"],
           "project_id": req["project_id"], "project_name": (proj or {}).get("name") or ""}
    with audit.guard("requirement.delete", **ctx):
        R.ChangeSetRepo.delete_by_requirement(db, rid)
        R.RequirementRepo.delete(db, rid)
    audit.log("requirement.delete", **ctx)
    return {"ok": True}


# ---------------- 工作流：需求澄清 → 用例配置 → 编码实现 → 归档验收 ----------------

def _require_requirement(db: sqlite3.Connection, rid: int, allowed: set) -> dict:
    """取需求并校验项目权限；需求不存在 / 越权分别给 404 / 403。"""
    req = R.RequirementRepo.get(db, rid)
    if req is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    if req["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    return req


def _require_project(db: sqlite3.Connection, pid: int) -> dict:
    proj = R.ProjectRepo.get(db, pid)
    if proj is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    return proj


def _mirror_requirement_docs(db: sqlite3.Connection, req: dict,
                             requirement: bool = False, design: bool = False) -> None:
    """把需求文档镜像到工作区 .janus/{需求目录}/requirement/ 下（best-effort，失败不阻断保存）。

    数据库是正文的权威来源；落盘只是给编码 Agent 一个稳定的读取路径，
    常用指令「参考详细设计文档」引用的正是 .janus/{dir}/requirement/design.md。
    """
    if not (requirement or design):
        return
    d = req.get("dir_name") or WD.sanitize_dir_name(req.get("title") or "")
    try:
        proj = _require_project(db, req["project_id"])
        if requirement:
            WD.write_doc(proj["disk_path"], WD.requirement_origin(d), req.get("description") or "")
        if design:
            WD.write_doc(proj["disk_path"], WD.requirement_design(d), req.get("design_doc") or "")
    except Exception as e:  # noqa: BLE001
        print(f"[warn] mirror requirement docs failed: {e}", flush=True)


def _export_test_cases(db: sqlite3.Connection, rid: int) -> None:
    """把用例清单导出到工作区 .janus/{需求目录}/usecase/usercase.md（best-effort）。

    「执行配置的单测」这条常用指令引用的就是这个文件：用例在「用例配置」阶段
    配好（含附件路径），编码 Agent 在「编码实现」阶段按它逐条执行。
    """
    try:
        req = R.RequirementRepo.get(db, rid)
        if not req:
            return
        proj = _require_project(db, req["project_id"])
        d = req.get("dir_name") or WD.sanitize_dir_name(req.get("title") or "")
        cases = R.TestCaseRepo.list_by_requirement(db, rid)
        atts = R.AttachmentRepo.list_by_requirement(db, rid)
        WD.write_doc(proj["disk_path"], WD.usecase_doc(d),
                     WD.export_test_cases(cases, atts, d))
    except Exception as e:  # noqa: BLE001
        print(f"[warn] export test cases failed: {e}", flush=True)


def _require_case(db: sqlite3.Connection, cid: int, allowed: set) -> dict:
    case = R.TestCaseRepo.get(db, cid)
    if case is None:
        raise HTTPException(status_code=404, detail="用例不存在")
    _require_requirement(db, case["requirement_id"], allowed)
    return case


def _pick_agent(db: sqlite3.Connection, rid: int = 0, session_id: int | None = None):
    """挑一个 agent 承接 AI 任务：按列表顺序取第一个可用者。

    排序即调度优先级（Agent 管理页可拖拽调整）；Token 日限额当日用满的顺位跳过，
    全部超限则返回 None。rid / session_id 保留在签名里仅为兼容旧调用方。
    """
    usage = R.AgentRepo.usage_map(db)
    for a in R.AgentRepo.list(db):
        if R.AgentRepo.is_available(a, usage.get(a["id"], 0)):
            return a
    return None


def _valid_status(status: str | None) -> str:
    if status is None or status not in CASE_STATUSES:
        raise HTTPException(status_code=400,
                            detail=f"用例状态只能是 {'/'.join(CASE_STATUSES)}")
    return status


@app.patch("/api/requirements/{rid}")
def update_requirement(rid: int, body: RequirementUpdate, allowed: set = Depends(get_allowed),
                       db: sqlite3.Connection = Depends(get_db)):
    """更新需求标题 / 需求文档 / 当前阶段（只改显式传入的字段）。

    标题或文档真的改了才留一条版本快照（内容没变不留，避免点几次保存就多几条空历史）；
    只切阶段不留版本 —— 阶段是流程状态，不是文档内容。
    """
    before = _require_requirement(db, rid, allowed)
    title = R.UNSET
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(status_code=400, detail="需求标题不能为空")
        title = body.title.strip()[:200]
        if title != before["title"]:
            # 目录名 .janus/{dir}/ 依据需求名称在创建时定死；改名会让 agent 已引用的路径失效
            raise HTTPException(status_code=400,
                                detail="需求名称创建后不可修改（.janus/ 工作区目录名依据需求名称固定）")
    if body.stage is not None and body.stage not in STAGES:
        raise HTTPException(status_code=400, detail=f"阶段只能是 {'/'.join(STAGES)}")
    # 工作流模式切换（工作台随时可切）：只认 full/lite，其余值忽略不报错
    mode = body.mode if body.mode in ("full", "lite") else None
    source = body.source if body.source in R.VERSION_SOURCES else "manual"
    out = R.RequirementRepo.update(db, rid, title=title,
                                   description=body.description if body.description is not None else R.UNSET,
                                   design_doc=body.design_doc if body.design_doc is not None else R.UNSET,
                                   stage=body.stage if body.stage is not None else R.UNSET,
                                   mode=mode if mode is not None else R.UNSET)
    if title is not R.UNSET or body.description is not None:
        R.RequirementVersionRepo.create_if_changed(db, rid, out["title"], out["description"], source=source)
    # 文档正文有变时镜像到工作区，编码 Agent 才能按固定路径读到
    if body.description is not None:
        _mirror_requirement_docs(db, out, requirement=True)
    if body.design_doc is not None:
        _mirror_requirement_docs(db, out, design=True)
    # 只记真的变了的字段：点一下保存没改东西，不该在审计里刷一条
    changed: dict = {}
    if title is not R.UNSET and title != before["title"]:
        changed["title"] = {"from": before["title"], "to": title}
    if body.description is not None and body.description != (before["description"] or ""):
        changed["document"] = {"from_chars": len(before["description"] or ""),
                               "to_chars": len(body.description), "source": source}
    if body.design_doc is not None and body.design_doc != (before.get("design_doc") or ""):
        changed["design_doc"] = {"from_chars": len(before.get("design_doc") or ""),
                                 "to_chars": len(body.design_doc)}
    if body.stage is not None and body.stage != (before.get("stage") or "clarify"):
        changed["stage"] = {"from": before.get("stage"), "to": body.stage}
    if mode is not None and mode != (before.get("mode") or "full"):
        changed["mode"] = {"from": before.get("mode") or "full", "to": mode}
    if changed:
        proj = R.ProjectRepo.get(db, out["project_id"])
        audit.log("requirement.update", target_type="requirement", target_id=rid,
                  target_name=out["title"], project_id=out["project_id"],
                  project_name=(proj or {}).get("name") or "", detail=changed)
    return out


# ---------------- 需求澄清：文档历史版本 ----------------

def _version_brief(v: dict) -> dict:
    """版本列表项：不返回正文，只给字数与首行摘要，列表再长也不拖慢接口。"""
    desc = v["description"] or ""
    first = next((ln.strip() for ln in desc.splitlines() if ln.strip()), "")
    return {
        "id": v["id"], "title": v["title"], "source": v["source"],
        "note": v["note"], "created_at": v["created_at"],
        "chars": len(desc.strip()),
        "preview": first[:60],
    }


@app.get("/api/requirements/{rid}/versions")
def list_requirement_versions(rid: int, allowed: set = Depends(get_allowed),
                              db: sqlite3.Connection = Depends(get_db)):
    """需求文档的历史版本，新版在前。"""
    _require_requirement(db, rid, allowed)
    rows = R.RequirementVersionRepo.list_by_requirement(db, rid)
    current = R.RequirementRepo.get(db, rid) or {}
    out = []
    for i, v in enumerate(rows):
        item = _version_brief(v)
        # 与当前需求内容一致的那一版就是当前生效版本（回退后会出现多版同内容，
        # 只标最新的一条，不必在前端重复算）
        item["current"] = (
            i == 0
            and v["title"] == (current.get("title") or "")
            and v["description"] == (current.get("description") or "")
        )
        out.append(item)
    return out


@app.get("/api/requirements/{rid}/versions/{vid}")
def get_requirement_version(rid: int, vid: int, allowed: set = Depends(get_allowed),
                            db: sqlite3.Connection = Depends(get_db)):
    """单个版本的完整正文，用于预览 / 对比。"""
    _require_requirement(db, rid, allowed)
    v = R.RequirementVersionRepo.get(db, vid)
    if v is None or v["requirement_id"] != rid:
        raise HTTPException(status_code=404, detail="版本不存在")
    return v


@app.post("/api/requirements/{rid}/versions/{vid}/restore")
def restore_requirement_version(rid: int, vid: int, allowed: set = Depends(get_allowed),
                                db: sqlite3.Connection = Depends(get_db)):
    """把需求文档回退到指定历史版本。

    回退不是「删掉之后的历史」，而是把旧内容作为一次**新的修改**写回去，
    并再记一条 source=revert 的版本 —— 于是回退本身也留在历史里、也能再回退。
    """
    req = _require_requirement(db, rid, allowed)
    v = R.RequirementVersionRepo.get(db, vid)
    if v is None or v["requirement_id"] != rid:
        raise HTTPException(status_code=404, detail="版本不存在")
    out = R.RequirementRepo.update(db, rid, title=v["title"], description=v["description"])
    R.RequirementVersionRepo.create(db, rid, out["title"], out["description"],
                                    source="revert", note=f"回退到版本 #{vid}")
    _mirror_requirement_docs(db, out, requirement=True)
    proj = R.ProjectRepo.get(db, out["project_id"])
    audit.log("requirement.restore", target_type="requirement", target_id=rid,
              target_name=out["title"], project_id=out["project_id"],
              project_name=(proj or {}).get("name") or "",
              detail={"version_id": vid, "from_chars": len(req["description"] or ""),
                      "to_chars": len(v["description"] or "")})
    return out


@app.post("/api/requirements/{rid}/stage")
def set_requirement_stage(rid: int, body: StageIn, allowed: set = Depends(get_allowed),
                          db: sqlite3.Connection = Depends(get_db)):
    """切换工作流阶段。离开「归档验收」时清空验收结论，等价于撤销归档。"""
    req = _require_requirement(db, rid, allowed)
    if body.stage not in STAGES:
        raise HTTPException(status_code=400, detail=f"阶段只能是 {'/'.join(STAGES)}")
    if body.stage == "archive":
        out = R.RequirementRepo.update(db, rid, stage="archive")
    else:
        out = R.RequirementRepo.update(db, rid, stage=body.stage,
                                       archived_at=None, verdict="", verdict_note="")
    proj = R.ProjectRepo.get(db, out["project_id"])
    audit.log("requirement.stage", target_type="requirement", target_id=rid,
              target_name=out["title"], project_id=out["project_id"],
              project_name=(proj or {}).get("name") or "",
              detail={"from": req.get("stage") or "clarify", "to": body.stage})
    return out


@app.get("/api/requirements/{rid}/workflow")
def requirement_workflow(rid: int, allowed: set = Depends(get_allowed),
                         db: sqlite3.Connection = Depends(get_db)):
    """工作流看板数据：阶段、用例统计、会话数、改动文件、验收结论（步骤条与归档页共用）。"""
    req = _require_requirement(db, rid, allowed)
    proj = R.ProjectRepo.get(db, req["project_id"])
    sessions = []
    for s in R.SessionRepo.list_by_requirement(db, rid):
        # 带上 Agent 名：需求列表「从已有会话进入」的选择器按它区分会话
        agent = R.AgentRepo.get(db, s["agent_id"]) if s.get("agent_id") else None
        sessions.append({
            "id": s["id"],
            "created_at": s.get("created_at"),
            "git_branch": s.get("git_branch"),
            "agent": agent["name"] if agent else None,
            "messages": _count(db, "SELECT COUNT(*) FROM messages WHERE session_id=?", (s["id"],)),
        })
    changes = {"available": False, "files": [], "truncated": False}
    if proj:
        changes = D.status_files(proj["disk_path"])
    return {
        "requirement": req,
        "stage": req.get("stage") or "clarify",
        "cases": R.TestCaseRepo.stats(db, rid),
        "sessions": sessions,
        "changes": changes,
        # 平台自己记录的改动（不依赖 git），归档验收汇总与编码实现阶段都用它
        "change_sets": R.ChangeSetRepo.summary_by_requirement(db, rid),
        "versions": len(R.RequirementVersionRepo.list_by_requirement(db, rid)),
        "archived_at": req.get("archived_at"),
        "verdict": req.get("verdict") or "",
        "verdict_note": req.get("verdict_note") or "",
    }


@app.post("/api/requirements/{rid}/archive")
def archive_requirement(rid: int, body: ArchiveIn, allowed: set = Depends(get_allowed),
                        db: sqlite3.Connection = Depends(get_db)):
    """归档验收：记录结论并落到 archive 阶段。"""
    _require_requirement(db, rid, allowed)
    if body.verdict not in VERDICTS:
        raise HTTPException(status_code=400, detail=f"验收结论只能是 {'/'.join(VERDICTS)}")
    now = datetime.datetime.now().isoformat(timespec="seconds")
    out = R.RequirementRepo.update(db, rid, stage="archive", archived_at=now,
                                   verdict=body.verdict,
                                   verdict_note=(body.note or "").strip()[:2000])
    proj = R.ProjectRepo.get(db, out["project_id"])
    audit.log("requirement.archive", target_type="requirement", target_id=rid,
              target_name=out["title"], project_id=out["project_id"],
              project_name=(proj or {}).get("name") or "",
              detail={"verdict": body.verdict, "note": (body.note or "").strip()[:500]})
    return out


# ---------------- 功能验证：用例 CRUD ----------------

@app.get("/api/requirements/{rid}/cases")
def list_cases(rid: int, allowed: set = Depends(get_allowed),
               db: sqlite3.Connection = Depends(get_db)):
    _require_requirement(db, rid, allowed)
    return R.TestCaseRepo.list_by_requirement(db, rid)


@app.post("/api/requirements/{rid}/cases")
def create_case(rid: int, body: CaseIn, allowed: set = Depends(get_allowed),
                db: sqlite3.Connection = Depends(get_db)):
    _require_requirement(db, rid, allowed)
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="用例标题不能为空")
    out = R.TestCaseRepo.create(db, rid, title[:200], body.steps, body.expected,
                                _valid_status(body.status), body.note, body.source or "manual",
                                is_manual=1 if body.is_manual else 0)
    _export_test_cases(db, rid)
    return out


@app.post("/api/requirements/{rid}/cases/bulk")
def bulk_create_cases(rid: int, body: CaseBulkIn, allowed: set = Depends(get_allowed),
                      db: sqlite3.Connection = Depends(get_db)):
    """批量写入用例（AI 生成后由用户确认再提交），空标题项自动跳过。"""
    _require_requirement(db, rid, allowed)
    items = []
    for c in body.cases:
        if (c.title or "").strip():
            items.append({"title": c.title.strip(), "steps": c.steps, "expected": c.expected,
                          "status": c.status, "note": c.note, "source": c.source or "ai",
                          "is_manual": bool(c.is_manual)})
    created = R.TestCaseRepo.create_many(db, rid, items, source="ai")
    _export_test_cases(db, rid)
    return {"created": len(created), "cases": created}


@app.post("/api/requirements/{rid}/cases/import")
def import_cases_from_workspace(rid: int, allowed: set = Depends(get_allowed),
                                db: sqlite3.Connection = Depends(get_db)):
    """从工作区导入 AI 用例草稿（.janus/{dir}/usecase/cases-draft.md）并落库。

    「用例配置」右侧对话让 agent 生成用例时，agent 把 ```json 数组写进草稿文件
    （对话走流式输出，没有一键生成那 180s 的探针超时上限，慢模型也能跑完）；
    用户在左侧确认草稿内容后点「从工作区导入」落库。与库中现有用例同标题的条目
    自动跳过（草稿残留时重复导入不会刷出重复用例）；导入成功后删除草稿文件。
    """
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    d = req.get("dir_name") or WD.sanitize_dir_name(req.get("title") or "")
    rel = WD.usecase_draft(d)
    try:
        text = FS.read_file(proj["disk_path"], rel)["content"]
    except FS.FsError as e:
        code = getattr(e, "code", None) or 404
        detail = ("工作区里还没有用例草稿：先在右侧对话里点「生成单测用例」让 Agent 写入，再回来导入"
                  if code == 404 else str(e))
        raise HTTPException(status_code=code, detail=detail)
    if not text.strip():
        raise HTTPException(status_code=400, detail="用例草稿是空的：让 Agent 重新生成后再导入")
    try:
        cases = AI.parse_cases(text)
    except AI.AiTaskError as e:
        raise HTTPException(status_code=400, detail=e.message)
    existing = {c["title"] for c in R.TestCaseRepo.list_by_requirement(db, rid)}
    fresh = [c for c in cases if c["title"] not in existing]
    created = R.TestCaseRepo.create_many(db, rid, fresh, source="ai") if fresh else []
    _export_test_cases(db, rid)
    # 删除草稿防重复导入（best-effort：删不掉也不影响导入结果，同名条目下轮会被跳过）
    try:
        os.remove(FS.abs_path(FS.ensure_root(proj["disk_path"]), rel))
    except OSError as e:  # noqa: BLE001
        print(f"[warn] remove cases draft failed: {e}", flush=True)
    return {"created": len(created), "cases": created,
            "skipped": len(cases) - len(fresh), "total": len(cases)}


@app.patch("/api/cases/{cid}")
def update_case(cid: int, body: CaseUpdate, allowed: set = Depends(get_allowed),
                db: sqlite3.Connection = Depends(get_db)):
    """更新用例（含勾选验证结果：status = pending / passed / failed / skipped）。"""
    _require_case(db, cid, allowed)
    if body.title is not None and not body.title.strip():
        raise HTTPException(status_code=400, detail="用例标题不能为空")
    out = R.TestCaseRepo.update(
        db, cid,
        title=body.title.strip()[:200] if body.title is not None else R.UNSET,
        steps=body.steps if body.steps is not None else R.UNSET,
        expected=body.expected if body.expected is not None else R.UNSET,
        status=_valid_status(body.status) if body.status is not None else R.UNSET,
        note=body.note if body.note is not None else R.UNSET,
        is_manual=body.is_manual if body.is_manual is not None else R.UNSET,
    )
    _export_test_cases(db, out["requirement_id"])
    return out


@app.post("/api/requirements/{rid}/test-result/sync")
def sync_test_result(rid: int, allowed: set = Depends(get_allowed),
                     db: sqlite3.Connection = Depends(get_db)):
    """解析工作区测试报告（arch/test-result.md 的 Markdown 表格），回写用例状态。

    编码 Agent 只负责把报告写进工作区，归档验收页的统计读的却是库里的
    test_case.status——这条接口就是两者之间的同步链路：前端进入归档验收时调用，
    把报告里逐条「通过/失败/跳过/未执行」刷进用例状态。报告不存在时返回
    found=False（200，不报错：报告还没写是正常状态，页面照常展示 pending）。
    """
    req = _require_requirement(db, rid, allowed)
    proj = R.ProjectRepo.get(db, req["project_id"])
    if proj is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    out = TR.sync_cases(db, rid, proj["disk_path"], req.get("dir_name") or "")
    if out["updated"]:
        audit.log("requirement.test_result_sync", target_type="requirement", target_id=rid,
                  target_name=req["title"], project_id=req["project_id"],
                  project_name=(proj or {}).get("name") or "",
                  detail={"updated": out["updated"], "rows": out["rows"]})
    return out


def _accept_coverage(db, rid, proj, dir_name) -> dict:
    """按最近一次测试报告的「标题」列判定覆盖度：报告里出现过的标题算「已进脚本」，
    非人工且未出现的算「未覆盖」。报告缺失 / 无标题列时覆盖度未知（不判未覆盖）。"""
    content = TR.read_report(proj["disk_path"], dir_name) if dir_name else None
    titles = TR.report_titles(content) if content else set()
    cases = R.TestCaseRepo.list_by_requirement(db, rid)
    covered, uncovered = [], []
    known = bool(titles)
    for c in cases:
        if c.get("is_manual"):
            continue
        if known and c["title"] in titles:
            covered.append(c["id"])
        elif known:
            uncovered.append(c["id"])
    return {"known": known, "covered_ids": covered, "uncovered_ids": uncovered,
            "uncovered": len(uncovered)}


@app.get("/api/requirements/{rid}/accept-script")
def accept_script_status(rid: int, allowed: set = Depends(get_allowed),
                         db: sqlite3.Connection = Depends(get_db)):
    """总验收脚本状态：是否存在、路径、mtime、是否过期、入口语言，附覆盖度。"""
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    d = req.get("dir_name") or ""
    cases = R.TestCaseRepo.list_by_requirement(db, rid)
    status = ACC.script_status(cases, proj["disk_path"], d)
    status["coverage"] = _accept_coverage(db, rid, proj, d)
    return status


@app.post("/api/requirements/{rid}/accept-script/run")
def accept_script_run(rid: int, allowed: set = Depends(get_allowed),
                      db: sqlite3.Connection = Depends(get_db)):
    """执行总验收脚本 → 解析工作区测试报告回写用例状态。

    验收主路径不依赖 AI：直接在项目工作区跑 accept.*，脚本自己写 test-result.md，
    平台随后 sync 回红绿。脚本不存在时返回 ran=False + reason=no_script，前端引导先生成。
    """
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    d = req.get("dir_name") or ""
    result = ACC.run_script(proj["disk_path"], d)
    if not result.get("ran"):
        audit.log("requirement.accept_run", status="failure", target_type="requirement",
                  target_id=rid, target_name=req["title"], project_id=req["project_id"],
                  project_name=(proj or {}).get("name") or "",
                  error=result.get("reason") or "run_failed")
        return {**result, "sync": None}
    sync = TR.sync_cases(db, rid, proj["disk_path"], d)
    audit.log("requirement.accept_run", target_type="requirement", target_id=rid,
              target_name=req["title"], project_id=req["project_id"],
              project_name=(proj or {}).get("name") or "",
              detail={"entry": result.get("entry"), "exit_code": result.get("exit_code"),
                      "updated": sync.get("updated"), "rows": sync.get("rows")})
    return {**result, "sync": sync}


def _script_http(err: SCR.ScriptError) -> HTTPException:
    return HTTPException(status_code=err.code, detail=err.message)


@app.get("/api/requirements/{rid}/scripts")
def scripts_list(rid: int, allowed: set = Depends(get_allowed),
                 db: sqlite3.Connection = Depends(get_db)):
    """列出 .janus/{dir}/script/ 下的通用脚本（含 params / last_params）。"""
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    return SCR.list_scripts(proj["disk_path"], req.get("dir_name") or "")


@app.get("/api/requirements/{rid}/scripts/{name}")
def scripts_get(rid: int, name: str, allowed: set = Depends(get_allowed),
                db: sqlite3.Connection = Depends(get_db)):
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    try:
        return SCR.read_script(proj["disk_path"], req.get("dir_name") or "", name)
    except SCR.ScriptError as e:
        raise _script_http(e) from e


@app.put("/api/requirements/{rid}/scripts/{name}")
def scripts_put(rid: int, name: str, body: ScriptSaveIn,
                allowed: set = Depends(get_allowed),
                db: sqlite3.Connection = Depends(get_db)):
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    try:
        saved = SCR.write_script(proj["disk_path"], req.get("dir_name") or "", name, body.content or "")
    except SCR.ScriptError as e:
        raise _script_http(e) from e
    audit.log("requirement.script_save", target_type="requirement", target_id=rid,
              target_name=req["title"], project_id=req["project_id"],
              project_name=(proj or {}).get("name") or "",
              detail={"name": name})
    return saved


@app.delete("/api/requirements/{rid}/scripts/{name}")
def scripts_delete(rid: int, name: str, allowed: set = Depends(get_allowed),
                   db: sqlite3.Connection = Depends(get_db)):
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    try:
        SCR.delete_script(proj["disk_path"], req.get("dir_name") or "", name)
    except SCR.ScriptError as e:
        raise _script_http(e) from e
    audit.log("requirement.script_delete", target_type="requirement", target_id=rid,
              target_name=req["title"], project_id=req["project_id"],
              project_name=(proj or {}).get("name") or "",
              detail={"name": name})
    return {"ok": True}


@app.post("/api/requirements/{rid}/scripts/{name}/run")
def scripts_run(rid: int, name: str, body: ScriptRunIn,
                allowed: set = Depends(get_allowed),
                db: sqlite3.Connection = Depends(get_db)):
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    try:
        result = SCR.run_script(proj["disk_path"], req.get("dir_name") or "", name, body.params or {})
    except SCR.ScriptError as e:
        raise _script_http(e) from e
    if not result.get("ran"):
        audit.log("requirement.script_run", status="failure", target_type="requirement",
                  target_id=rid, target_name=req["title"], project_id=req["project_id"],
                  project_name=(proj or {}).get("name") or "",
                  error=result.get("reason") or "run_failed",
                  detail={"name": name})
    else:
        audit.log("requirement.script_run", target_type="requirement", target_id=rid,
                  target_name=req["title"], project_id=req["project_id"],
                  project_name=(proj or {}).get("name") or "",
                  detail={"name": name, "exit_code": result.get("exit_code"),
                          "duration_ms": result.get("duration_ms")})
    return result


@app.get("/api/requirements/{rid}/scripts/{name}/runs")
def scripts_runs(rid: int, name: str, allowed: set = Depends(get_allowed),
                 db: sqlite3.Connection = Depends(get_db)):
    req = _require_requirement(db, rid, allowed)
    proj = _require_project(db, req["project_id"])
    try:
        return SCR.list_runs(proj["disk_path"], req.get("dir_name") or "", name)
    except SCR.ScriptError as e:
        raise _script_http(e) from e


@app.delete("/api/cases/{cid}")
def delete_case(cid: int, allowed: set = Depends(get_allowed),
                db: sqlite3.Connection = Depends(get_db)):
    case = _require_case(db, cid, allowed)
    R.TestCaseRepo.delete(db, cid)
    _export_test_cases(db, case["requirement_id"])
    return {"ok": True}


@app.post("/api/cases/batch-delete")
def batch_delete_cases(body: CaseBatchDeleteIn, allowed: set = Depends(get_allowed),
                       db: sqlite3.Connection = Depends(get_db)):
    """批量删除用例：先整批校验（存在性 + 权限）再动手，任一条不合格就整批不动。

    前端「删除选中」一次勾几条用不过来时用它；单删仍走 DELETE /api/cases/{cid}。
    """
    ids = list(dict.fromkeys(body.ids or []))
    if not ids:
        raise HTTPException(status_code=400, detail="请先勾选要删除的用例")
    cases = [_require_case(db, cid, allowed) for cid in ids]
    for c in cases:
        R.TestCaseRepo.delete(db, c["id"])
    for rid in {c["requirement_id"] for c in cases}:
        _export_test_cases(db, rid)
    return {"deleted": len(cases)}


# ---------------- 功能验证：AI 生成用例 / 需求澄清：AI 润色 ----------------

def _ai_context(rid: int, body: AiTaskIn | None, token: str | None, admin: str | None):
    """AI 任务前的一次性取数：权限、需求、agent、项目根目录。

    异步端点不能使用同步 get_db 依赖（连接会跨线程），因此这里自取自放。
    """
    conn = get_conn()
    try:
        allowed = resolve_access(conn, token, admin)
        if allowed is None:
            raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
        req = _require_requirement(conn, rid, allowed)
        proj = R.ProjectRepo.get(conn, req["project_id"])
        if proj is None:
            raise HTTPException(status_code=404, detail="项目不存在")
        agent = _pick_agent(conn, rid, body.session_id if body else None)
        if agent is None:
            raise HTTPException(
                status_code=400,
                detail="没有可用的 coding agent（可能今日 Token 限额已用完）；"
                       "请先到「Agent 管理」调整限额、顺序或添加一个 agent",
            )
        # 前端直传的 doc / title 优先：编辑框里的内容可能还没保存，库里是旧的
        doc = ((body.doc if body else None) or "").strip() or (req.get("description") or "").strip()
        title = ((body.title if body else None) or "").strip() or (req.get("title") or "")
        req = dict(req)
        req["title"] = title
        return req, proj, agent, doc
    finally:
        conn.close()


@app.post("/api/requirements/{rid}/cases/generate")
async def generate_cases(rid: int, body: AiTaskIn | None = None,
                         token: str = Query(None), admin: str = Query(None),
                         request: Request = None):
    """一键生成用例：把需求文档交给 agent，解析其 JSON 输出并落库。

    「模型答了但格式不对」不算接口错误：返回 created=0 + warning + AI 原文，
    由用户决定重试或手动补齐；只有调用层面失败（超时/未认证/无输出）才报 502。
    """
    body = body or AiTaskIn()
    req, proj, agent, doc = _ai_context(rid, body, token, admin)
    if not doc:
        raise HTTPException(status_code=400,
                            detail="需求文档为空：请先在「需求澄清」阶段补充需求描述，再生成用例")
    warning = ""
    raw = ""
    cases: list[dict] = []
    elapsed = 0
    agent_name = None
    try:
        out = await AI.generate_cases(agent, req["title"], doc, proj["disk_path"],
                                      body.count, body.timeout, context=_ai_audit_context(req, proj, body))
        cases, raw, elapsed, agent_name = out["cases"], out["raw"], out["elapsed_ms"], out.get("agent_name")
    except AI.AiTaskError as e:
        if e.kind != "parse":
            raise HTTPException(status_code=502, detail=e.message)
        warning, raw = e.message, e.raw

    created = []
    if cases:
        conn = get_conn()
        try:
            created = R.TestCaseRepo.create_many(conn, rid, cases, source="ai")
            _export_test_cases(conn, rid)
        finally:
            conn.close()
    if not created and not warning:
        warning = "AI 未输出可解析的用例 JSON，可重试或手动新增用例。"
    return {"created": len(created), "cases": created, "raw": raw, "warning": warning,
            "elapsed_ms": elapsed, "agent": agent_name}


def _ai_audit_context(req: dict, proj: dict, body: AiTaskIn | None) -> dict:
    """AI 任务的留痕归属：哪个项目 / 哪条需求 / 哪个会话 / 谁点的。"""
    return {
        "project_id": proj["id"], "project_name": proj["name"],
        "requirement_id": req["id"], "requirement_title": req["title"],
        "session_id": body.session_id if body else None,
        "actor": audit.actor(),
    }


@app.post("/api/requirements/{rid}/polish")
async def polish_requirement(rid: int, body: AiTaskIn | None = None,
                             token: str = Query(None), admin: str = Query(None),
                             request: Request = None):
    """AI 润色需求文档：返回润色后的正文，由用户确认后再保存（不直接改库）。"""
    body = body or AiTaskIn()
    req, proj, agent, doc = _ai_context(rid, body, token, admin)
    if not doc:
        raise HTTPException(status_code=400, detail="需求文档为空：请先写下需求草稿，再让 AI 润色")
    try:
        out = await AI.polish_document(agent, req["title"], doc, proj["disk_path"], body.timeout,
                                       context=_ai_audit_context(req, proj, body))
    except AI.AiTaskError as e:
        if e.kind != "parse":
            raise HTTPException(status_code=502, detail=e.message)
        return {"content": "", "raw": e.raw, "warning": e.message, "elapsed_ms": 0, "agent": None}
    return {"content": out["content"], "raw": out["raw"], "warning": "", "elapsed_ms": out["elapsed_ms"],
            "agent": out.get("agent_name")}


@app.post("/api/requirements/{rid}/design")
async def generate_design_doc(rid: int, body: AiTaskIn | None = None,
                              token: str = Query(None), admin: str = Query(None),
                              request: Request = None):
    """AI 依据原始需求生成详细设计文档：返回正文，由用户采纳后保存（不直接改库）。

    与润色共用解析器（parse_polished）；需求附件的路径会写进提示词，agent 在
    项目根目录运行，可以直接打开 .janus/{需求目录}/requirement/attach/ 下的附件看上下文。
    """
    body = body or AiTaskIn()
    req, proj, agent, doc = _ai_context(rid, body, token, admin)
    if not doc:
        raise HTTPException(status_code=400,
                            detail="需求文档为空：请先在「原始需求」里写下要做什么，再生成设计文档")
    conn = get_conn()
    try:
        atts = R.AttachmentRepo.list_by_requirement(conn, rid)
    finally:
        conn.close()
    att_paths = [a["path"] for a in atts if not a.get("case_id")]
    try:
        out = await AI.generate_design(agent, req["title"], doc, proj["disk_path"],
                                       att_paths, body.timeout,
                                       context=_ai_audit_context(req, proj, body))
    except AI.AiTaskError as e:
        if e.kind != "parse":
            raise HTTPException(status_code=502, detail=e.message)
        return {"content": "", "raw": e.raw, "warning": e.message, "elapsed_ms": 0, "agent": None}
    return {"content": out["content"], "raw": out["raw"], "warning": "", "elapsed_ms": out["elapsed_ms"],
            "agent": out.get("agent_name")}


# ---------------- 工作流附件：需求附件与用例附件 ----------------
#
# 文件实体存项目工作区 .janus/{需求目录}/ 下（编码 Agent 可按路径读取），数据库只记元信息。
# 用例附件入库后立即重导出用例清单，保证 .janus/{dir}/usecase/usercase.md 里路径是最新的。

def _save_workflow_attachments(db: sqlite3.Connection, req: dict, files: list[UploadFile],
                               case_id: int | None, subdir: str) -> list[dict]:
    proj = _require_project(db, req["project_id"])
    out: list[dict] = []
    for f in files:
        if f is None:
            continue
        filename = f.filename or "attachment"
        data = f.file.read()
        rel = WD.save_attachment(proj["disk_path"], subdir, filename, data)
        out.append(R.AttachmentRepo.create(db, req["id"], case_id, filename, rel, len(data)))
    return out


@app.post("/api/requirements/{rid}/attachments")
def upload_requirement_attachments(rid: int, files: list[UploadFile] = File(...),
                                   allowed: set = Depends(get_allowed),
                                   db: sqlite3.Connection = Depends(get_db)):
    """需求澄清阶段上传附件（支持多文件），存 .janus/{需求目录}/requirement/attach/。"""
    req = _require_requirement(db, rid, allowed)
    d = req.get("dir_name") or WD.sanitize_dir_name(req.get("title") or "")
    rows = _save_workflow_attachments(db, req, files, None, WD.requirement_attach_subdir(d))
    proj = R.ProjectRepo.get(db, req["project_id"])
    if rows:
        audit.log("requirement.attach", target_type="requirement", target_id=rid,
                  target_name=req["title"], project_id=req["project_id"],
                  project_name=(proj or {}).get("name") or "",
                  detail={"count": len(rows),
                          "names": [r["filename"] for r in rows][:10]})
    return rows


@app.post("/api/cases/{cid}/attachments")
def upload_case_attachments(cid: int, files: list[UploadFile] = File(...),
                            allowed: set = Depends(get_allowed),
                            db: sqlite3.Connection = Depends(get_db)):
    """给单条用例上传附件，存 .janus/{需求目录}/usecase/attach/，并重导出用例清单。"""
    case = _require_case(db, cid, allowed)
    rid = case["requirement_id"]
    req = R.RequirementRepo.get(db, rid)
    d = (req or {}).get("dir_name") or WD.sanitize_dir_name((req or {}).get("title") or "")
    rows = _save_workflow_attachments(db, req, files, cid, WD.usecase_attach_subdir(d))
    _export_test_cases(db, rid)
    proj = R.ProjectRepo.get(db, (req or {}).get("project_id"))
    if rows:
        audit.log("case.attach", target_type="case", target_id=cid,
                  target_name=case["title"], project_id=(req or {}).get("project_id"),
                  project_name=(proj or {}).get("name") or "",
                  detail={"count": len(rows),
                          "names": [r["filename"] for r in rows][:10]})
    return rows


@app.get("/api/requirements/{rid}/attachments")
def list_workflow_attachments(rid: int, allowed: set = Depends(get_allowed),
                              db: sqlite3.Connection = Depends(get_db)):
    """需求的全部附件（含用例附件，按 case_id 区分）。"""
    _require_requirement(db, rid, allowed)
    return R.AttachmentRepo.list_by_requirement(db, rid)


@app.delete("/api/attachments/{aid}")
def delete_workflow_attachment(aid: int, allowed: set = Depends(get_allowed),
                               db: sqlite3.Connection = Depends(get_db)):
    att = R.AttachmentRepo.get(db, aid)
    if att is None:
        raise HTTPException(status_code=404, detail="附件不存在")
    req = _require_requirement(db, att["requirement_id"], allowed)
    try:
        proj = _require_project(db, req["project_id"])
        WD.delete_attachment(proj["disk_path"], att["path"])
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"[warn] delete attachment file failed: {e}", flush=True)
    R.AttachmentRepo.delete(db, aid)
    if att.get("case_id"):
        _export_test_cases(db, att["requirement_id"])
    return {"ok": True}


# ---------------- 编码实现：工作区改动记录与回退 ----------------
#
# 记录来自一次 agent 运行前后的工作区快照比对（见 snapshots.py），所以不依赖目标
# 项目是不是 git 仓库。这里负责「看」和「退」：列表、详情（含统一 diff）、回退。

def _require_change_set(db: sqlite3.Connection, csid: int, allowed: set) -> dict:
    cs = R.ChangeSetRepo.get(db, csid)
    if cs is None:
        raise HTTPException(status_code=404, detail="改动记录不存在")
    if cs["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    return cs


def _change_set_brief(db: sqlite3.Connection, row: dict) -> dict:
    """列表项：只带前几个文件路径做预览，明细走详情接口，避免一次拉爆。"""
    files = R.ChangeSetRepo.list_files(db, row["id"])
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "session_id": row["session_id"],
        "requirement_id": row["requirement_id"],
        "source": row["source"],
        "note": row["note"],
        "created_at": row["created_at"],
        "added": row["added"],
        "modified": row["modified"],
        "removed": row["removed"],
        "truncated": bool(row["truncated"]),
        "file_count": len(files),
        "preview": [{"path": f["path"], "status": f["status"]} for f in files[:5]],
    }


@app.get("/api/projects/{pid}/changesets")
def list_change_sets(pid: int, session_id: int | None = Query(None),
                     limit: int = Query(50), allowed: set = Depends(get_allowed),
                     db: sqlite3.Connection = Depends(get_db)):
    """项目下的工作区改动记录，按时间倒序；可按会话过滤。"""
    if pid not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    rows = R.ChangeSetRepo.list_by_project(db, pid, session_id, max(1, min(limit, 200)))
    return [_change_set_brief(db, r) for r in rows]


@app.get("/api/changesets/{csid}")
def change_set_detail(csid: int, allowed: set = Depends(get_allowed),
                      db: sqlite3.Connection = Depends(get_db)):
    """改动明细：逐文件的状态、字数与统一 diff。diff 在服务端算好，前端直接展示。"""
    cs = _require_change_set(db, csid, allowed)
    files = []
    for f in R.ChangeSetRepo.list_files(db, csid):
        files.append({
            "id": f["id"],
            "path": f["path"],
            "status": f["status"],
            "binary": bool(f["binary"]),
            "revertible": not bool(f["binary"]),
            "before_chars": len(f["before"] or ""),
            "after_chars": len(f["after"] or ""),
            "diff": "" if f["binary"] else SN.unified(f["before"], f["after"], f["path"]),
        })
    return {**_change_set_brief(db, cs), "files": files}


def _apply_revert(db, proj: dict, cs: dict, files: list) -> dict:
    """按记录把文件恢复成改动前的内容，并为这次回退本身再记一条改动记录。

    记这条新记录是刻意的：回退也是一次真实改动，它同样可追溯、也同样可以再回退，
    否则「回退」就成了历史里的一个黑洞。
    """
    results = SN.apply_revert(proj["disk_path"], [
        {"path": f["path"], "before": f["before"], "binary": f["binary"]} for f in files
    ])
    ok_paths = {r["path"] for r in results if r.get("ok")}
    done = [f for f in files if f["path"] in ok_paths]
    skipped = len(files) - len(done)
    new_cs = None
    if done:
        note = f"回退改动记录 #{cs['id']}"
        if skipped:
            note += f"（{skipped} 个文件跳过）"
        new_cs = R.ChangeSetRepo.create(
            db, cs["project_id"], session_id=cs["session_id"],
            requirement_id=cs["requirement_id"], source="revert", note=note)
        for f in done:
            # 回退记录的 before/after 与原记录互换
            if f["before"] is None:
                status = "removed"      # 原记录是新增 → 回退即删除
            elif f["after"] is None:
                status = "added"        # 原记录是删除 → 回退即重建
            else:
                status = "modified"
            R.ChangeSetRepo.add_file(db, new_cs["id"], f["path"], status,
                                     before=f["after"], after=f["before"])
        new_cs = R.ChangeSetRepo.recount(db, new_cs["id"])
    return {
        "ok": skipped == 0,
        "reverted": len(done),
        "skipped": skipped,
        "results": results,
        "change_set": new_cs,
    }


@app.post("/api/changesets/{csid}/revert")
def revert_change_set(csid: int, allowed: set = Depends(get_allowed),
                      db: sqlite3.Connection = Depends(get_db)):
    """回退整条改动记录：所有文件恢复成这次改动之前的样子。"""
    cs = _require_change_set(db, csid, allowed)
    proj = R.ProjectRepo.get(db, cs["project_id"])
    if proj is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    files = R.ChangeSetRepo.list_files(db, csid)
    if not files:
        raise HTTPException(status_code=400, detail="这条改动记录里没有文件")
    try:
        out = _apply_revert(db, proj, cs, files)
    except Exception as e:  # noqa: BLE001 - 回退写盘可能失败，失败同样要留痕
        audit.log("changeset.revert", status="failure", target_type="changeset", target_id=csid,
                  project_id=cs["project_id"], project_name=proj["name"],
                  detail={"files": len(files)}, error=f"{type(e).__name__}: {e}")
        raise
    audit.log("changeset.revert", target_type="changeset", target_id=csid,
              project_id=cs["project_id"], project_name=proj["name"],
              detail={"files": len(files), "reverted": out.get("reverted"),
                      "skipped": out.get("skipped")})
    return out


@app.post("/api/changesets/{csid}/files/{fid}/revert")
def revert_change_file(csid: int, fid: int, allowed: set = Depends(get_allowed),
                       db: sqlite3.Connection = Depends(get_db)):
    """只回退这条记录里的某一个文件。"""
    cs = _require_change_set(db, csid, allowed)
    proj = R.ProjectRepo.get(db, cs["project_id"])
    if proj is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    f = R.ChangeSetRepo.get_file(db, fid)
    if f is None or f["change_set_id"] != csid:
        raise HTTPException(status_code=404, detail="该改动记录里没有这个文件")
    try:
        out = _apply_revert(db, proj, cs, [f])
    except Exception as e:  # noqa: BLE001
        audit.log("changeset.revert_file", status="failure", target_type="changeset",
                  target_id=csid, project_id=cs["project_id"], project_name=proj["name"],
                  detail={"path": f["path"]}, error=f"{type(e).__name__}: {e}")
        raise
    audit.log("changeset.revert_file", target_type="changeset", target_id=csid,
              project_id=cs["project_id"], project_name=proj["name"],
              detail={"path": f["path"], "reverted": out.get("reverted")})
    return out


# ---------------- 需求设计工作台 ----------------

@app.post("/api/sessions")
def create_session(body: dict, db: sqlite3.Connection = Depends(get_db), token: str = Query(None),
                   admin: str = Query(None), request: Request = None):
    allowed = resolve_access(db, token, admin)
    if allowed is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    rid = body.get("requirement_id")
    if rid is None:
        raise HTTPException(status_code=400, detail="缺少 requirement_id")
    req = R.RequirementRepo.get(db, rid)
    if req is None:
        raise HTTPException(status_code=400, detail="需求不存在")
    if req["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    proj = R.ProjectRepo.get(db, req["project_id"])
    # 可选：新建会话时指定 agent；未传则按排序取第一个当日可用的
    agent_id = body.get("agent_id")
    if agent_id is not None:
        try:
            agent_id = int(agent_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="agent_id 必须是整数")
    # 建会话会在项目仓库里 checkout 新分支（见 SessionService.create），属于改仓库状态
    try:
        out = S.SessionService.create(db, rid, agent_id=agent_id)
    except ValueError as e:
        audit.log("session.create", status="failure", target_type="session",
                  target_name=req["title"], project_id=req["project_id"],
                  project_name=(proj or {}).get("name") or "", error=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        audit.log("session.create", status="failure", target_type="session",
                  target_name=req["title"], project_id=req["project_id"],
                  project_name=(proj or {}).get("name") or "", error=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    audit.log("session.create", target_type="session", target_id=out["id"],
              target_name=req["title"], project_id=req["project_id"],
              project_name=(proj or {}).get("name") or "",
              detail={"requirement_id": rid, "git_branch": out.get("git_branch"),
                      "agent_id": out.get("agent_id")})
    return out


@app.patch("/api/sessions/{sid}/agent")
def set_session_agent(sid: int, body: SessionAgentIn, db: sqlite3.Connection = Depends(get_db),
                      token: str = Query(None), admin: str = Query(None)):
    """切换会话当前使用的 coding agent（对话面板多 Agent 时可选）。

    换 Agent 会清空 CLI 续聊 id，下一轮消息按新 Agent 重新起聊；
    Agent 运行中禁止切换。
    """
    allowed = resolve_access(db, token, admin)
    if allowed is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    sess = R.SessionRepo.get(db, sid)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    proj = R.ProjectRepo.get(db, sess["project_id"])
    req = R.RequirementRepo.get(db, sess["requirement_id"])
    try:
        out = S.SessionService.set_agent(db, sid, body.agent_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    agent = R.AgentRepo.get(db, out["agent_id"])
    audit.log("session.set_agent", target_type="session", target_id=sid,
              target_name=(req or {}).get("title") or "",
              project_id=sess["project_id"],
              project_name=(proj or {}).get("name") or "",
              detail={"agent_id": out.get("agent_id"),
                      "agent_name": (agent or {}).get("name")})
    return {
        "id": out["id"],
        "agent_id": out["agent_id"],
        "agent": {"id": agent["id"], "name": agent["name"], "type": agent["type"]} if agent else None,
    }


@app.get("/api/sessions/{sid}")
def session_detail(sid: int, db: sqlite3.Connection = Depends(get_db), token: str = Query(None),
                   admin: str = Query(None)):
    """会话详情：工作台靠它拿到 project_id / 项目磁盘路径，从而不依赖 URL 上的 pid。

    沉浸式工作台只带 session id 也能自洽：项目、需求、Agent、分支都在这里一次给全。
    """
    allowed = resolve_access(db, token, admin)
    if allowed is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    sess = R.SessionRepo.get(db, sid)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    proj = R.ProjectRepo.get(db, sess["project_id"])
    req = R.RequirementRepo.get(db, sess["requirement_id"])
    agent = R.AgentRepo.get(db, sess["agent_id"])
    out = dict(sess)
    out["project"] = proj["name"] if proj else None
    out["disk_path"] = proj["disk_path"] if proj else None
    out["requirement"] = dict(req) if req else None
    out["agent"] = {"id": agent["id"], "name": agent["name"], "type": agent["type"]} if agent else None
    return out


@app.get("/api/sessions/{sid}/messages")
def session_history(sid: int, db: sqlite3.Connection = Depends(get_db), token: str = Query(None),
                    admin: str = Query(None)):
    allowed = resolve_access(db, token, admin)
    if allowed is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    sess = R.SessionRepo.get(db, sid)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    return R.MessageRepo.list_by_session(db, sid)


@app.post("/api/sessions/{sid}/attachments")
def upload_session_attachments(sid: int, files: list[UploadFile] = File(...),
                               db: sqlite3.Connection = Depends(get_db),
                               token: str = Query(None), admin: str = Query(None)):
    """对话输入框粘贴/选择的文件：存到 .janus/{需求目录}/chat/attach/，返回项目内相对路径。

    不落 DB：路径随消息文本一并发出（消息里带 [[janus:files]] 引用），既能被 Agent
    直接读取，也能在历史消息里点开预览。鉴权与其他会话接口一致（令牌/管理员）。
    """
    allowed = resolve_access(db, token, admin)
    if allowed is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    sess = R.SessionRepo.get(db, sid)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    proj = _require_project(db, sess["project_id"])
    req = R.RequirementRepo.get(db, sess["requirement_id"])
    d = (req or {}).get("dir_name") or WD.sanitize_dir_name((req or {}).get("title") or "")
    out: list[dict] = []
    for f in files:
        if f is None:
            continue
        filename = f.filename or "attachment"
        data = f.file.read()
        try:
            rel = WD.save_attachment(proj["disk_path"], WD.chat_attach_subdir(d), filename, data)
        except FS.FsError as e:
            raise HTTPException(status_code=getattr(e, "code", 400) or 400, detail=str(e))
        out.append({"path": rel, "filename": filename, "size": len(data)})
    if out:
        audit.log("session.attach", target_type="session", target_id=sid,
                  target_name=(req or {}).get("title") or "", project_id=sess["project_id"],
                  project_name=(proj or {}).get("name") or "",
                  detail={"count": len(out), "names": [r["filename"] for r in out][:10]})
    return out


@app.get("/api/sessions/{sid}/events")
async def stream_events(
    sid: int,
    message: str = Query(...),
    token: str = Query(None),
    admin: str = Query(None),
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
            allowed = resolve_access(conn, token, admin)
            if allowed is None:
                async for y in _sse_error("无效或缺失访问令牌"):
                    yield y
                return
            sess = R.SessionRepo.get(conn, sid)
            if sess is None:
                async for y in _sse_error("会话不存在"):
                    yield y
                return
            if sess["project_id"] not in allowed:
                async for y in _sse_error("无权访问该项目"):
                    yield y
                return
            # 限额守门：会话绑定的 Agent 当日 Token 限额用满即不可用，不再启动运行
            agent_row = R.AgentRepo.get(conn, sess["agent_id"])
            if agent_row is not None:
                used = R.AgentRepo.usage_map(conn).get(agent_row["id"], 0)
                if not R.AgentRepo.is_available(agent_row, used):
                    async for y in _sse_error(
                        f"Agent「{agent_row['name']}」的今日 Token 限额已用完"
                        f"（{R.AgentRepo.quota_text(agent_row, used)}），暂不可用；"
                        "请在「Agent 管理」调整限额，或将其他可用 Agent 拖到前面"
                    ):
                        yield y
                    return
            proj = R.ProjectRepo.get(conn, sess["project_id"])
            mode, run_id = S.SessionService.resolve_run(
                conn, sid, message, actor=audit.identify(conn, token, admin))
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
            done: dict = {"type": "done"}
            # 幂等回放也带上落库的耗时 / Token，前端收口气泡与刷新后展示一致
            agent_tail = [m for m in msgs[last_user_idx + 1:] if m.get("role") == "agent"]
            if agent_tail:
                last = agent_tail[-1]
                if last.get("elapsed_ms") is not None:
                    done["elapsed_ms"] = last["elapsed_ms"]
                u = {}
                for k in ("prompt_tokens", "completion_tokens", "total_tokens"):
                    if last.get(k) is not None:
                        u[k] = last[k]
                if u:
                    done["usage"] = u
            yield f"data: {json.dumps(done, ensure_ascii=False)}\n\n"
            return

        # live / new：订阅后台 run 的实时流（payload 已含 diff，无需重算）
        async for ev in S.SessionService.stream_run(run_id):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/sessions/{sid}/active-run")
def session_active_run(sid: int, db: sqlite3.Connection = Depends(get_db), token: str = Query(None),
                       admin: str = Query(None)):
    """该会话是否仍有进行中的 agent 运行；有则返回触发它的原始消息。

    前端刷新后对话流就断了（SSE 连接随页面销毁），run 本身在后台继续跑。
    前端挂载时先问这里：仍在跑就拿着 message 重新订阅 /events（同一消息幂等续传，
    不重复调 agent），流式内容从事件 0 完整回放，刷新不再丢输出。
    """
    allowed = resolve_access(db, token, admin)
    if allowed is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    sess = R.SessionRepo.get(db, sid)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    run_id, message = S.SessionService.active_run_for_session(sid)
    return {"active": run_id is not None, "run_id": run_id, "message": message}


@app.post("/api/sessions/{sid}/abort")
async def abort_session_run(sid: int, db: sqlite3.Connection = Depends(get_db),
                            token: str = Query(None), admin: str = Query(None)):
    """真中止会话进行中的 agent 运行：取消后台 run 任务，CLI 适配器连进程树杀掉子进程。

    为什么这里必须是 async def（不要改成 def）：task.cancel() 只能在事件循环所在线程
    调用；sync 路由跑在线程池里，跨线程 cancel 不安全，会出现「接口返回成功、
    run 却继续跑」的假中止。响应体 {aborted: false} 表示此刻没有进行中的 run。
    """
    allowed = resolve_access(db, token, admin)
    if allowed is None:
        raise HTTPException(status_code=401, detail="无效或缺失访问令牌")
    sess = R.SessionRepo.get(db, sid)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess["project_id"] not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    proj = R.ProjectRepo.get(db, sess["project_id"])
    run_id, message = S.SessionService.abort_run(sid)
    if run_id is not None:
        audit.log("session.abort", target_type="session", target_id=sid,
                  target_name=(R.RequirementRepo.get(db, sess["requirement_id"]) or {})
                  .get("title", ""),
                  project_id=sess["project_id"],
                  project_name=(proj or {}).get("name") or "",
                  detail={"run_id": run_id, "message": (message or "")[:120]})
    return {"aborted": run_id is not None, "run_id": run_id, "message": message}


async def _sse_error(text):
    """错误事件后追加 done，使客户端及时关闭流（避免 EventSource 自动重连空转）。"""
    yield f"data: {json.dumps({'type': 'error', 'text': text}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"


# ---------------- 实时日志（项目运行诊断流） ----------------
#
# 数据来自进程内日志总线（backend/logbus.py），不是数据库：
# 它观测的是「此刻正在发生什么」，落库的追责台账是 /api/admin/audit-logs 与
# /api/admin/invocations 的职责。两个接口分工：
#   · GET  .../logs         增量拉取（首屏加载 + SSE 断线后的兜底）
#   · GET  .../logs/stream  SSE 实时推送（轮询总线快照，心跳保活）
# 鉴权与项目白名单与文件接口完全一致：令牌/管理员口令 → 可见项目集合。

LOG_POLL_SECONDS = 0.6      # 总线轮询间隔：0.6s 的延迟对「实时日志」已足够，且开销极小
LOG_STREAM_LIMIT = 1000     # 单次推送最多带走多少条，超过则提示「产生过快」


def _log_filters(level, source):
    """解析 ``?level=info,warn`` / ``?source=agent,audit``：逗号分隔多值，空表示不过滤。"""
    def _split(v):
        return [x.strip() for x in str(v).split(",") if x.strip()] if v else None
    return _split(level), _split(source)


@app.get("/api/projects/{pid}/logs")
def project_logs(pid: int, after_seq: int = Query(0), limit: int = Query(500),
                 level: str = Query(None), source: str = Query(None),
                 include_global: bool = Query(False),
                 allowed: set = Depends(get_allowed)):
    """增量读取某个项目的运行日志。

    ``after_seq`` 之后的记录才会返回（用于断点续读）；``include_global=True`` 时把平台级
    记录（未绑定项目的 Agent 一键测试等）一并带上。返回里 ``dropped`` 表示缓冲已滚出过
    客户端尚未读到的记录，``truncated`` 表示命中条数超过 limit。
    """
    if pid not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    levels, sources = _log_filters(level, source)
    limit = max(1, min(int(limit or 500), LOG.MAX_RECORDS))
    return LOG.snapshot(pid, after_seq=after_seq, limit=limit, levels=levels,
                        sources=sources, include_global=include_global)


@app.get("/api/projects/{pid}/logs/stream")
async def stream_project_logs(pid: int, after_seq: int = Query(0),
                              level: str = Query(None), source: str = Query(None),
                              include_global: bool = Query(False),
                              token: str = Query(None), admin: str = Query(None)):
    """SSE：实时推送某个项目的运行日志。

    与 ``/api/sessions/{sid}/events`` 一样用 query 传令牌（EventSource 不能自定义请求头）。
    连接建立后先补发 ``after_seq`` 之后已产生的记录，再按固定间隔轮询总线增量推送；
    浏览器 EventSource 断线重连时会带上同一个 after_seq，客户端按 seq 去重即可。

    权限沿用 ``resolve_access``：令牌只可见被授权项目，管理员口令可见全部项目。
    """
    levels, sources = _log_filters(level, source)

    def chunk(payload: dict) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    async def gen():
        conn = get_conn()
        try:
            allowed = resolve_access(conn, token, admin)
            if allowed is None:
                async for y in _sse_error("无效或缺失访问令牌"):
                    yield y
                return
            if pid not in allowed:
                async for y in _sse_error("无权访问该项目"):
                    yield y
                return
            proj = R.ProjectRepo.get(conn, pid)
        finally:
            conn.close()

        stats = LOG.stats()
        yield chunk({"type": "hello", "project_id": pid,
                     "project": (proj or {}).get("name") or f"项目 #{pid}",
                     "buffered": stats["buffered"], "capacity": stats["capacity"]})
        seq = max(0, int(after_seq or 0))
        while True:
            snap = LOG.snapshot(pid, after_seq=seq, limit=LOG_STREAM_LIMIT,
                                levels=levels, sources=sources,
                                include_global=include_global)
            if snap["dropped"]:
                yield chunk({"type": "gap",
                             "text": f"更早的日志已被滚出缓冲（上限 {snap['capacity']} 条）"})
            if snap["truncated"]:
                yield chunk({"type": "gap", "text": "日志产生速度超过推送，本批只推送了最新部分"})
            for rec in snap["records"]:
                yield chunk({"type": "log", "record": rec})
            if snap["records"]:
                seq = snap["last_seq"]
            # 心跳注释行：让代理/浏览器知道连接还活着，也确保事件循环得到让出机会
            yield ": keep-alive\n\n"
            await asyncio.sleep(LOG_POLL_SECONDS)

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------------- 工作台文件面板（项目工作区文件的查看与增删改） ----------------

def _project_root(db: sqlite3.Connection, pid: int, allowed: set) -> str:
    """取项目磁盘根目录；权限与状态不满足时抛 HTTPException。"""
    if pid not in allowed:
        raise HTTPException(status_code=403, detail="无权访问该项目")
    proj = R.ProjectRepo.get(db, pid)
    if proj is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    try:
        return FS.ensure_root(proj["disk_path"])
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)


def _fs_guard(fn, *args, **kwargs):
    """把 FS.FsError 统一翻译成对应状态码的 HTTPException。"""
    try:
        return fn(*args, **kwargs)
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)


def _fs_audited(action: str, db: sqlite3.Connection, pid: int,
                rel: str, fn, detail=None):
    """执行一次改盘操作，成功与失败都写操作日志。

    改盘是最敏感的一类动作（文件面板直接动的是别人的真实代码），所以失败路径也必须留痕：
    只记成功等于把「谁把哪个文件删失败了」这条最有用的线索丢掉。
    """
    proj = R.ProjectRepo.get(db, pid)
    ctx = {"target_type": "file", "target_name": rel, "project_id": pid,
           "project_name": (proj or {}).get("name") or "", "detail": detail}
    try:
        out = fn()
    except FS.FsError as e:
        audit.log(action, status="failure", error=e.message, **ctx)
        raise HTTPException(status_code=e.code, detail=e.message)
    except Exception as e:  # noqa: BLE001
        audit.log(action, status="failure", error=f"{type(e).__name__}: {e}", **ctx)
        raise
    audit.log(action, **ctx)
    return out


@app.get("/api/projects/{pid}/files")
def list_project_files(pid: int, path: str = Query(""), allowed: set = Depends(get_allowed),
                       db: sqlite3.Connection = Depends(get_db)):
    """列出一个目录的直接子项（不递归），供工作台文件面板逐层展开。"""
    root = _project_root(db, pid, allowed)
    try:
        rel = FS.norm_rel(path)
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)
    return _fs_guard(FS.list_dir, root, rel)


@app.get("/api/projects/{pid}/files/search")
def search_project_files(pid: int, q: str = Query("", min_length=0),
                         limit: int = Query(FS.MAX_SEARCH_RESULTS, ge=1, le=FS.MAX_SEARCH_RESULTS),
                         allowed: set = Depends(get_allowed),
                         db: sqlite3.Connection = Depends(get_db)):
    """按文件名模糊检索整个工作区（子串 + 子序列），供 Files 面板搜索框。"""
    root = _project_root(db, pid, allowed)
    query = (q or "").strip()
    if not query:
        return {"query": "", "entries": [], "truncated": False, "limit": limit}
    return _fs_guard(FS.search_files, root, query, limit)


@app.get("/api/projects/{pid}/file")
def read_project_file(pid: int, path: str = Query(...), allowed: set = Depends(get_allowed),
                      db: sqlite3.Connection = Depends(get_db)):
    root = _project_root(db, pid, allowed)
    try:
        rel = FS.norm_rel(path)
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)
    return _fs_guard(FS.read_file, root, rel)


@app.get("/api/projects/{pid}/file/raw")
def read_project_file_raw(pid: int, path: str = Query(...), download: bool = Query(False),
                          allowed: set = Depends(get_allowed),
                          db: sqlite3.Connection = Depends(get_db)):
    """按原始字节流返回文件（带 MIME），供工作台预览 PDF / 图片 / 表格 / 文档。

    预览用的二进制通道：只读、不落库、不进审计（与 file.read 同级），
    路径校验复用 files.raw_meta（realpath 包含性检查，防越界）。
    """
    root = _project_root(db, pid, allowed)
    try:
        meta = FS.raw_meta(root, FS.norm_rel(path))
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)
    headers = None
    if download:
        from urllib.parse import quote
        name = meta["path"].rsplit("/", 1)[-1]
        headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"}
    return FileResponse(meta["abs_path"], media_type=meta["media_type"], headers=headers)


@app.get("/api/projects/{pid}/raw/{rel_path:path}")
def read_project_file_raw_nested(pid: int, rel_path: str, download: bool = Query(False),
                                 allowed: set = Depends(get_allowed),
                                 db: sqlite3.Connection = Depends(get_db)):
    """路径内嵌版 raw 接口：HTML 预览用它做 iframe 地址，
    页面里的相对引用（script src="assets/x.js" 之类）会自然解析到同一路由下。"""
    return read_project_file_raw(pid=pid, path=rel_path, download=download,
                                 allowed=allowed, db=db)


@app.put("/api/projects/{pid}/file")
def write_project_file(pid: int, body: FileWriteIn, allowed: set = Depends(get_allowed),
                       db: sqlite3.Connection = Depends(get_db)):
    """保存（或新建）文件内容。写盘动作属业务操作，只需访问令牌，无需管理员口令。"""
    root = _project_root(db, pid, allowed)
    try:
        rel = FS.norm_rel(body.path)
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)
    out = _fs_audited("file.write", db, pid, rel,
                      lambda: FS.write_file(root, rel, body.content),
                      detail={"chars": len(body.content or "")})
    return out


@app.post("/api/projects/{pid}/files")
def create_project_entry(pid: int, body: FileCreateIn, allowed: set = Depends(get_allowed),
                         db: sqlite3.Connection = Depends(get_db)):
    root = _project_root(db, pid, allowed)
    if body.type not in ("file", "dir"):
        raise HTTPException(status_code=400, detail="type 只能是 file 或 dir")
    try:
        rel = FS.norm_rel(body.path)
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)
    return _fs_audited("file.create", db, pid, rel,
                       lambda: FS.create_entry(root, rel, body.type),
                       detail={"type": body.type})


@app.post("/api/projects/{pid}/files/rename")
def rename_project_entry(pid: int, body: FileRenameIn, allowed: set = Depends(get_allowed),
                         db: sqlite3.Connection = Depends(get_db)):
    root = _project_root(db, pid, allowed)
    try:
        rel = FS.norm_rel(body.path)
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)
    return _fs_audited("file.rename", db, pid, rel,
                       lambda: FS.rename_entry(root, rel, body.new_name),
                       detail={"new_name": body.new_name})


@app.delete("/api/projects/{pid}/files")
def delete_project_entry(pid: int, path: str = Query(...), recursive: bool = Query(False),
                         allowed: set = Depends(get_allowed),
                         db: sqlite3.Connection = Depends(get_db)):
    """删除文件或目录；目录非空时必须显式 recursive=True。"""
    root = _project_root(db, pid, allowed)
    try:
        rel = FS.norm_rel(path)
    except FS.FsError as e:
        raise HTTPException(status_code=e.code, detail=e.message)
    return _fs_audited("file.delete", db, pid, rel,
                       lambda: FS.delete_entry(root, rel, recursive),
                       detail={"recursive": bool(recursive)})


# ---------------- 管理台 API（需管理员口令） ----------------

def _count(conn, sql, args=()) -> int:
    return conn.execute(sql, args).fetchone()[0]


def _mask(tok: str) -> str:
    if len(tok) <= 12:
        return tok[:4] + "…"
    return f"{tok[:6]}…{tok[-4:]}"


def _token_expiry_error(exc: Exception):
    """把有效期参数错误翻译成 400，避免落到 500 兜底。"""
    raise HTTPException(status_code=400, detail=str(exc)) from exc


def _token_row(t: dict) -> dict:
    exp = t.get("expires_at")
    expired = False
    if exp:
        try:
            expired = datetime.datetime.fromisoformat(exp) < datetime.datetime.now()
        except ValueError:
            expired = False
    return {
        "id": t["id"],
        "masked": _mask(t["token"]),
        "project_ids": t["project_ids"],
        "expires_at": exp,
        "expired": expired,
        "note": t.get("note") or "",
        "created_at": t.get("created_at") or None,
    }


@app.get("/api/admin/state")
def admin_state():
    """前端据此判断是否要求输入口令。"""
    from .config import CONFIG
    return {"admin_enabled": bool(CONFIG.admin_token)}


@app.get("/api/admin/verify")
def admin_verify(admin: str = Query(None)):
    """校验管理员口令是否有效，供统一登录弹框的「管理员登录」使用。

    与 require_admin 的区别：开放模式（未配置 CAP_ADMIN_TOKEN）下 require_admin 一律放行，
    那是为了兼容开放端点；但登录场景下「任何口令都能登录」是错的，这里明确回 400 让前端
    提示「无需登录 / 未启用口令」，而不是把空口令当成合法凭证。
    """
    from .config import CONFIG
    if not CONFIG.admin_token:
        raise HTTPException(
            status_code=400,
            detail="后端未启用管理员口令（开放模式），无需管理员登录",
        )
    if not _is_admin(admin):
        raise HTTPException(status_code=401, detail="管理员口令不正确")
    return {"ok": True, "admin_enabled": True}


@app.get("/api/admin/overview")
def admin_overview(db: sqlite3.Connection = Depends(get_db), _ok=Depends(require_admin)):
    return {
        "projects": _count(db, "SELECT COUNT(*) FROM projects"),
        "requirements": _count(db, "SELECT COUNT(*) FROM requirements"),
        "sessions": _count(db, "SELECT COUNT(*) FROM sessions"),
        "messages": _count(db, "SELECT COUNT(*) FROM messages"),
        "agents": _count(db, "SELECT COUNT(*) FROM agents"),
        "tokens": _count(db, "SELECT COUNT(*) FROM tokens"),
    }


@app.get("/api/admin/projects")
def admin_projects(db: sqlite3.Connection = Depends(get_db), _ok=Depends(require_admin)):
    out = []
    for p in R.ProjectRepo.list(db):
        d = dict(p)
        d["requirements"] = _count(db, "SELECT COUNT(*) FROM requirements WHERE project_id=?", (p["id"],))
        d["sessions"] = _count(db, "SELECT COUNT(*) FROM sessions WHERE project_id=?", (p["id"],))
        out.append(d)
    return out


@app.post("/api/admin/projects")
def admin_create_project(body: ProjectCreate, db: sqlite3.Connection = Depends(get_db),
                         _ok=Depends(require_admin)):
    if not os.path.isdir(body.disk_path):
        audit.log("project.create", status="failure", target_name=body.name,
                  detail={"disk_path": body.disk_path},
                  error=f"磁盘路径不存在或不是目录: {body.disk_path}")
        raise HTTPException(status_code=400, detail=f"磁盘路径不存在或不是目录: {body.disk_path}")
    out = R.ProjectRepo.create(db, body.name, body.disk_path)
    audit.log("project.create", target_type="project", target_id=out["id"],
              target_name=out["name"], project_id=out["id"], project_name=out["name"],
              detail={"disk_path": out["disk_path"], "from": "admin_console"})
    return out


@app.delete("/api/admin/projects/{pid}")
def admin_delete_project(pid: int, db: sqlite3.Connection = Depends(get_db),
                         _ok=Depends(require_admin)):
    p = R.ProjectRepo.get(db, pid)
    if p is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    ctx = {"target_type": "project", "target_id": pid, "target_name": p["name"],
           "project_id": pid, "project_name": p["name"],
           "detail": {"disk_path": p["disk_path"], "from": "admin_console"}}
    with audit.guard("project.delete", **ctx):
        R.ProjectRepo.delete(db, pid)
    audit.log("project.delete", **ctx)
    return {"ok": True}


@app.post("/api/admin/projects/batch-delete")
def admin_batch_delete_projects(body: BatchIdsIn, db: sqlite3.Connection = Depends(get_db),
                                _ok=Depends(require_admin)):
    """批量删除项目：先整批校验存在性，任一条不存在则整批不动。"""
    ids = list(dict.fromkeys(body.ids or []))
    if not ids:
        raise HTTPException(status_code=400, detail="请先勾选要删除的项目")
    rows = []
    for pid in ids:
        p = R.ProjectRepo.get(db, pid)
        if p is None:
            raise HTTPException(status_code=404, detail=f"项目 #{pid} 不存在")
        rows.append(p)
    for p in rows:
        ctx = {"target_type": "project", "target_id": p["id"], "target_name": p["name"],
               "project_id": p["id"], "project_name": p["name"],
               "detail": {"disk_path": p["disk_path"], "from": "admin_console", "batch": True}}
        with audit.guard("project.delete", **ctx):
            R.ProjectRepo.delete(db, p["id"])
        audit.log("project.delete", **ctx)
    return {"deleted": len(rows)}


@app.get("/api/admin/tokens")
def admin_tokens(db: sqlite3.Connection = Depends(get_db), _ok=Depends(require_admin)):
    return [_token_row(t) for t in R.TokenRepo.list(db)]


@app.post("/api/admin/tokens")
def admin_issue_token(body: AdminTokenIssue, db: sqlite3.Connection = Depends(get_db),
                      _ok=Depends(require_admin)):
    ids = body.project_ids or [p["id"] for p in R.ProjectRepo.list(db)]
    if not ids:
        raise HTTPException(status_code=400, detail="尚无可授权的项目，请先创建项目")
    try:
        expires_at = auth.compute_expiry(body.ttl_days, body.expires_at)
    except auth.TokenExpiryError as e:
        _token_expiry_error(e)
    tok = auth.TokenService.issue(db, ids, expires_at=expires_at, note=body.note)
    row = R.TokenRepo.get(db, _token_id(db, tok))
    audit.log("token.issue", target_type="token", target_id=row["id"] if row else None,
              target_name=audit.mask_token(tok),
              detail={"project_ids": ids, "expires_at": expires_at, "note": body.note or ""})
    return {
        "token": tok,
        "link": f"{public_share_base()}/?token={tok}",
        "project_ids": ids,
        "expires_at": expires_at,
        "note": body.note or "",
        "id": row["id"] if row else None,
    }


def _token_id(db, tok: str):
    r = db.execute("SELECT id FROM tokens WHERE token=?", (tok,)).fetchone()
    return r[0] if r else None


@app.get("/api/admin/tokens/{tid}/reveal")
def admin_reveal_token(tid: int, db: sqlite3.Connection = Depends(get_db),
                       _ok=Depends(require_admin)):
    """查看已签发令牌的完整原文（不再只在签发瞬间可见一次）。"""
    t = R.TokenRepo.get(db, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="令牌不存在或已被吊销")
    row = _token_row(t)
    row.update({"token": t["token"], "link": f"{public_share_base()}/?token={t['token']}"})
    # 明文令牌被读走是这个平台风险最高的一件事：必须留痕，且只留脱敏串
    audit.log("token.reveal", target_type="token", target_id=tid,
              target_name=audit.mask_token(t["token"]),
              detail={"note": t.get("note") or "", "expires_at": t.get("expires_at")})
    return row


@app.patch("/api/admin/tokens/{tid}")
def admin_update_token(tid: int, body: AdminTokenUpdate,
                       db: sqlite3.Connection = Depends(get_db), _ok=Depends(require_admin)):
    """更新备注和/或有效期；never_expires=True 表示改为永不过期。"""
    t = R.TokenRepo.get(db, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="令牌不存在或已被吊销")
    try:
        expires_at = auth.compute_expiry(body.ttl_days, body.expires_at)
    except auth.TokenExpiryError as e:
        _token_expiry_error(e)
    ok = R.TokenRepo.update(
        db,
        tid,
        note=body.note if body.note is not None else R.UNSET,
        expires_at=expires_at if body.expires_at or body.ttl_days else R.UNSET,
        clear_expiry=bool(body.never_expires),
    )
    if not ok:
        raise HTTPException(status_code=404, detail="令牌不存在或已被吊销")
    out = _token_row(R.TokenRepo.get(db, tid))
    audit.log("token.update", target_type="token", target_id=tid,
              target_name=audit.mask_token(t["token"]),
              detail={"note": {"from": t.get("note") or "", "to": out["note"]},
                      "expires_at": {"from": t.get("expires_at"), "to": out["expires_at"]}})
    return out


@app.delete("/api/admin/tokens/{tid}")
def admin_revoke_token(tid: int, db: sqlite3.Connection = Depends(get_db),
                       _ok=Depends(require_admin)):
    t = R.TokenRepo.get(db, tid)
    ctx = {"target_type": "token", "target_id": tid,
           "target_name": audit.mask_token((t or {}).get("token") or ""),
           "detail": {"note": (t or {}).get("note") or "",
                      "project_ids": (t or {}).get("project_ids")}}
    with audit.guard("token.revoke", **ctx):
        R.TokenRepo.delete(db, tid)
    audit.log("token.revoke", **ctx)
    return {"ok": True}


@app.post("/api/admin/tokens/batch-delete")
def admin_batch_revoke_tokens(body: BatchIdsIn, db: sqlite3.Connection = Depends(get_db),
                              _ok=Depends(require_admin)):
    """批量吊销令牌：先整批校验存在性，任一条不存在则整批不动。"""
    ids = list(dict.fromkeys(body.ids or []))
    if not ids:
        raise HTTPException(status_code=400, detail="请先勾选要吊销的令牌")
    rows = []
    for tid in ids:
        t = R.TokenRepo.get(db, tid)
        if t is None:
            raise HTTPException(status_code=404, detail=f"令牌 #{tid} 不存在或已被吊销")
        rows.append(t)
    for t in rows:
        ctx = {"target_type": "token", "target_id": t["id"],
               "target_name": audit.mask_token(t.get("token") or ""),
               "detail": {"note": t.get("note") or "", "project_ids": t.get("project_ids"),
                          "batch": True}}
        with audit.guard("token.revoke", **ctx):
            R.TokenRepo.delete(db, t["id"])
        audit.log("token.revoke", **ctx)
    return {"deleted": len(rows)}


@app.get("/api/admin/agents")
def admin_agents(db: sqlite3.Connection = Depends(get_db), _ok=Depends(require_admin)):
    return _agents_enriched(db)


@app.get("/api/admin/sessions")
def admin_sessions(db: sqlite3.Connection = Depends(get_db), _ok=Depends(require_admin)):
    rows = db.execute(
        """SELECT s.id, s.created_at, s.git_branch, r.title AS requirement, r.id AS requirement_id,
                  p.name AS project, p.id AS project_id
           FROM sessions s
           LEFT JOIN requirements r ON r.id = s.requirement_id
           LEFT JOIN projects p ON p.id = s.project_id
           ORDER BY s.id DESC LIMIT 200"""
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["messages"] = _count(db, "SELECT COUNT(*) FROM messages WHERE session_id=?", (r["id"],))
        out.append(d)
    return out


@app.delete("/api/admin/sessions/{sid}")
def admin_delete_session(sid: int, db: sqlite3.Connection = Depends(get_db),
                         _ok=Depends(require_admin)):
    s = R.SessionRepo.get(db, sid)
    if s is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    req = R.RequirementRepo.get(db, s["requirement_id"]) if s.get("requirement_id") else None
    proj = R.ProjectRepo.get(db, s["project_id"]) if s.get("project_id") else None
    ctx = {
        "target_type": "session", "target_id": sid,
        "target_name": (req or {}).get("title") or f"会话 #{sid}",
        "project_id": s.get("project_id"),
        "project_name": (proj or {}).get("name") or "",
        "detail": {"requirement_id": s.get("requirement_id"), "git_branch": s.get("git_branch"),
                   "from": "admin_console"},
    }
    with audit.guard("session.delete", **ctx):
        R.SessionRepo.delete(db, sid)
    audit.log("session.delete", **ctx)
    return {"ok": True}


@app.post("/api/admin/sessions/batch-delete")
def admin_batch_delete_sessions(body: BatchIdsIn, db: sqlite3.Connection = Depends(get_db),
                                _ok=Depends(require_admin)):
    """批量删除会话：先整批校验存在性，任一条不存在则整批不动。"""
    ids = list(dict.fromkeys(body.ids or []))
    if not ids:
        raise HTTPException(status_code=400, detail="请先勾选要删除的会话")
    rows = []
    for sid in ids:
        s = R.SessionRepo.get(db, sid)
        if s is None:
            raise HTTPException(status_code=404, detail=f"会话 #{sid} 不存在")
        rows.append(s)
    for s in rows:
        req = R.RequirementRepo.get(db, s["requirement_id"]) if s.get("requirement_id") else None
        proj = R.ProjectRepo.get(db, s["project_id"]) if s.get("project_id") else None
        ctx = {
            "target_type": "session", "target_id": s["id"],
            "target_name": (req or {}).get("title") or f"会话 #{s['id']}",
            "project_id": s.get("project_id"),
            "project_name": (proj or {}).get("name") or "",
            "detail": {"requirement_id": s.get("requirement_id"), "git_branch": s.get("git_branch"),
                       "from": "admin_console", "batch": True},
        }
        with audit.guard("session.delete", **ctx):
            R.SessionRepo.delete(db, s["id"])
        audit.log("session.delete", **ctx)
    return {"deleted": len(rows)}


# ---------------- 审计：操作日志 / Agent 调用留痕 ----------------

def _paging(limit: int, offset: int) -> tuple[int, int]:
    """收敛分页参数，避免前端传个 limit=100000 把整张表拉回来。"""
    return max(1, min(int(limit or 50), 200)), max(0, int(offset or 0))


def _day_range(start, end) -> tuple[str | None, str | None]:
    """把前端的日期串归一成可直接比较的区间端点。

    日期选择器只给 ``YYYY-MM-DD``：作为起点补 00:00:00、作为终点补 23:59:59，
    否则「筛今天」会因为 ``2026-09-19`` < ``2026-09-19 10:00:00`` 而漏掉当天的记录。
    """
    def norm(v, is_end):
        v = (v or "").strip()
        if not v:
            return None
        if len(v) == 10 and v[4] == "-":
            return v + (" 23:59:59" if is_end else " 00:00:00")
        return v.replace("T", " ")[:19]
    return norm(start, False), norm(end, True)


def _int_or_none(v):
    try:
        return int(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _invocation_brief(row: dict) -> dict:
    """列表项：正文只给开头，全文走详情接口 —— 否则一页 50 条能把响应撑到几 MB。"""
    d = {k: v for k, v in row.items() if k not in ("prompt", "response")}
    d["prompt_preview"] = (row.get("prompt") or "")[:160]
    d["response_preview"] = (row.get("response") or "")[:160]
    d["prompt_chars"] = len(row.get("prompt") or "")
    d["response_chars"] = len(row.get("response") or "")
    return d


@app.get("/api/admin/audit-logs")
def admin_audit_logs(limit: int = Query(50), offset: int = Query(0),
                     category: str = Query(None), action: str = Query(None),
                     status: str = Query(None), actor_type: str = Query(None),
                     project_id: str = Query(None), q: str = Query(None),
                     start: str = Query(None), end: str = Query(None),
                     db: sqlite3.Connection = Depends(get_db), _ok=Depends(require_admin)):
    """操作日志检索：过滤、分页与统计共用同一套条件，页面上看到的数就是筛出来的数。"""
    start, end = _day_range(start, end)
    filters = {"category": category, "action": action, "status": status,
               "actor_type": actor_type, "project_id": _int_or_none(project_id),
               "q": q, "start": start, "end": end}
    lim, off = _paging(limit, offset)
    page = R.AuditLogRepo.query(db, filters, lim, off)
    return {
        "total": page["total"],
        "items": page["items"],
        "stats": R.AuditLogRepo.stats(db, filters),
        # 选项来自库里的真实数据，前端不必硬编码一份可能过时的枚举
        "facets": {"categories": R.AuditLogRepo.categories(db),
                   "actions": R.AuditLogRepo.actions(db)[:100]},
    }


@app.get("/api/admin/invocations")
def admin_invocations(limit: int = Query(50), offset: int = Query(0),
                      source: str = Query(None), status: str = Query(None),
                      agent_id: str = Query(None), project_id: str = Query(None),
                      requirement_id: str = Query(None), session_id: str = Query(None),
                      actor_type: str = Query(None), q: str = Query(None),
                      start: str = Query(None), end: str = Query(None),
                      db: sqlite3.Connection = Depends(get_db), _ok=Depends(require_admin)):
    """Agent 调用留痕检索：每一次调用（含失败）都能在这里查到。"""
    start, end = _day_range(start, end)
    filters = {"source": source, "status": status, "agent_id": _int_or_none(agent_id),
               "project_id": _int_or_none(project_id),
               "requirement_id": _int_or_none(requirement_id),
               "session_id": _int_or_none(session_id), "actor_type": actor_type,
               "q": q, "start": start, "end": end}
    lim, off = _paging(limit, offset)
    page = R.AgentInvocationRepo.query(db, filters, lim, off)
    return {
        "total": page["total"],
        "items": [_invocation_brief(r) for r in page["items"]],
        "stats": R.AgentInvocationRepo.stats(db, filters),
        "facets": {"agents": [{"id": a["id"], "name": a["name"], "type": a["type"]}
                              for a in R.AgentRepo.list(db)]},
    }


@app.get("/api/admin/invocations/{iid}")
def admin_invocation_detail(iid: int, db: sqlite3.Connection = Depends(get_db),
                            _ok=Depends(require_admin)):
    """单条调用的完整入参 / 出参（列表里只给摘要，避免一页拉回几十万字）。"""
    row = R.AgentInvocationRepo.get(db, iid)
    if row is None:
        raise HTTPException(status_code=404, detail="调用记录不存在")
    return row


# ---------------- 前端静态托管（若存在构建产物） ----------------

def _mount_web():
    from .config import CONFIG
    if CONFIG.web_dist.is_dir():
        app.mount("/", StaticFiles(directory=str(CONFIG.web_dist), html=True), name="web")


_mount_web()
