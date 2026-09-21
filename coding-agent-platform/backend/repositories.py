"""各实体的 CRUD 数据访问层（sqlite3 + sqlite3.Row）。"""
import json
from .db import row_to_dict

# 部分更新的哨兵：区分「调用方未传入该字段」与「显式传入 None」。
_UNSET = object()


class _Unset:
    """哨兵值：区分「没传这个字段」和「显式传了 None」。"""

    def __repr__(self):  # pragma: no cover - 仅便于调试
        return "<UNSET>"


_UNSET = _Unset()

# 对外使用的哨兵别名：调用方用它表示「该字段不参与本次更新」。
UNSET = _UNSET


class AgentRepo:
    # Token 日限额默认值：1000 万/天（当日用量达到限额后该 Agent 当天不可用，次日自动重置）
    DEFAULT_TOKEN_LIMIT = 10_000_000

    @staticmethod
    def create(conn, name, type_, config, token_limit=None):
        cfg = config if isinstance(config, str) else json.dumps(config, ensure_ascii=False)
        limit = AgentRepo.DEFAULT_TOKEN_LIMIT if token_limit is None else max(0, int(token_limit))
        cur = conn.execute(
            "INSERT INTO agents(name,type,config,token_limit) VALUES(?,?,?,?)",
            (name, type_, cfg, limit),
        )
        aid = cur.lastrowid
        # 新 Agent 排在最后：sort_order 取当前最大值 +1（取 id 会与拖拽排序的 1..n 冲突）
        conn.execute(
            "UPDATE agents SET sort_order=(SELECT COALESCE(MAX(sort_order),0)+1 FROM agents) WHERE id=?",
            (aid,),
        )
        conn.commit()
        return AgentRepo.get(conn, aid)

    @staticmethod
    def get(conn, aid):
        r = conn.execute("SELECT * FROM agents WHERE id=?", (aid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list(conn):
        # 排序即 AI 任务的调度优先级：列表顺序由 sort_order 决定（Agent 管理页可拖拽）
        return [row_to_dict(r) for r in
                conn.execute("SELECT * FROM agents ORDER BY sort_order, id").fetchall()]

    @staticmethod
    def update(conn, aid, name=_UNSET, type_=_UNSET, config=_UNSET, token_limit=_UNSET):
        """部分更新：只有显式传入的字段才会被修改（未传入的保持原值）。

        config 允许传 dict 或已是 JSON 字符串，与 create 保持一致；
        token_limit 为 0 表示不限额。
        """
        if config is not _UNSET:
            config = config if isinstance(config, str) else json.dumps(config, ensure_ascii=False)
        fields = []
        args = []
        for col, val in (("name", name), ("type", type_), ("config", config),
                         ("token_limit", token_limit)):
            if val is not _UNSET:
                fields.append(f"{col}=?")
                args.append(val)
        if not fields:
            return AgentRepo.get(conn, aid)
        args.append(aid)
        conn.execute(f"UPDATE agents SET {','.join(fields)} WHERE id=?", tuple(args))
        conn.commit()
        return AgentRepo.get(conn, aid)

    @staticmethod
    def reorder(conn, ids):
        """按传入的 id 顺序重排（位置从 1 开始），返回排好序的完整列表。"""
        for pos, aid in enumerate(ids, start=1):
            conn.execute("UPDATE agents SET sort_order=? WHERE id=?", (pos, aid))
        conn.commit()
        return AgentRepo.list(conn)

    @staticmethod
    def delete(conn, aid):
        conn.execute("DELETE FROM agents WHERE id=?", (aid,))
        conn.commit()

    # ---------------- Token 日限额与可用性 ----------------

    @staticmethod
    def usage_map(conn) -> dict:
        """各 Agent 的**今日** Token 用量（来自调用留痕的 total_tokens 按天汇总）。

        created_at 存的是本地时间（见建表语句），因此直接与 date('now','localtime')
        比较；跨天后昨日用量不再计入，限额自然重置。
        """
        rows = conn.execute(
            """SELECT agent_id, COALESCE(SUM(total_tokens),0) AS used
               FROM agent_invocations
               WHERE agent_id IS NOT NULL AND date(created_at)=date('now','localtime')
               GROUP BY agent_id"""
        ).fetchall()
        return {r["agent_id"]: int(r["used"] or 0) for r in rows}

    @staticmethod
    def token_limit_of(agent_row) -> int:
        """取限额；缺列或脏数据时回退默认值（老库迁移前的兜底）。"""
        try:
            return int((agent_row or {}).get("token_limit"))
        except (TypeError, ValueError):
            return AgentRepo.DEFAULT_TOKEN_LIMIT

    @staticmethod
    def is_available(agent_row, used: int = 0) -> bool:
        """当日限额用满即不可用；token_limit <= 0 表示不限额，恒可用。"""
        limit = AgentRepo.token_limit_of(agent_row)
        if limit <= 0:
            return True
        return int(used or 0) < limit

    @staticmethod
    def quota_text(agent_row, used: int = 0) -> str:
        limit = AgentRepo.token_limit_of(agent_row)
        lim = "不限" if limit <= 0 else f"{limit:,}"
        return f"今日已用 {int(used or 0):,} / 限额 {lim}"


class ProjectRepo:
    @staticmethod
    def create(conn, name, disk_path):
        cur = conn.execute("INSERT INTO projects(name,disk_path) VALUES(?,?)", (name, disk_path))
        conn.commit()
        return ProjectRepo.get(conn, cur.lastrowid)

    @staticmethod
    def get(conn, pid):
        r = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list(conn, allowed_ids=None):
        if allowed_ids is None:
            rows = conn.execute("SELECT * FROM projects ORDER BY id").fetchall()
        else:
            if not allowed_ids:
                return []
            q = f"SELECT * FROM projects WHERE id IN ({','.join('?'*len(allowed_ids))}) ORDER BY id"
            rows = conn.execute(q, list(allowed_ids)).fetchall()
        return [row_to_dict(r) for r in rows]

    @staticmethod
    def update(conn, pid, name=_UNSET, disk_path=_UNSET):
        """部分更新：只有显式传入的字段才会被修改（未传入的保持原值）。"""
        fields = []
        args = []
        for col, val in (("name", name), ("disk_path", disk_path)):
            if val is not _UNSET:
                fields.append(f"{col}=?")
                args.append(val)
        if not fields:
            return ProjectRepo.get(conn, pid)
        args.append(pid)
        conn.execute(f"UPDATE projects SET {','.join(fields)} WHERE id=?", tuple(args))
        conn.commit()
        return ProjectRepo.get(conn, pid)

    @staticmethod
    def delete(conn, pid):
        conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        conn.commit()


class RequirementRepo:
    @staticmethod
    def create(conn, project_id, title, description="", dir_name="", mode="full", stage="clarify"):
        cur = conn.execute(
            "INSERT INTO requirements(project_id,title,description,dir_name,mode,stage,"
            "created_at,updated_at) VALUES(?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))",
            (project_id, title, description, dir_name,
             mode if mode in ("full", "lite") else "full", stage),
        )
        conn.commit()
        return RequirementRepo.get(conn, cur.lastrowid)

    @staticmethod
    def get(conn, rid):
        r = conn.execute("SELECT * FROM requirements WHERE id=?", (rid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list_by_project(conn, project_id):
        return [row_to_dict(r) for r in
                conn.execute("SELECT * FROM requirements WHERE project_id=? ORDER BY id", (project_id,)).fetchall()]

    @staticmethod
    def update(conn, rid, title=_UNSET, description=_UNSET, design_doc=_UNSET, stage=_UNSET,
               archived_at=_UNSET, verdict=_UNSET, verdict_note=_UNSET, mode=_UNSET):
        """部分更新：只有显式传入的字段才会被修改（未传入的保持原值）。"""
        fields = []
        args = []
        for col, val in (("title", title), ("description", description),
                         ("design_doc", design_doc), ("stage", stage),
                         ("archived_at", archived_at), ("verdict", verdict),
                         ("verdict_note", verdict_note), ("mode", mode)):
            if val is not _UNSET:
                fields.append(f"{col}=?")
                args.append(val)
        if not fields:
            return RequirementRepo.get(conn, rid)
        args.append(rid)
        # 任何字段被修改都刷新 updated_at（需求列表卡片展示「更新于」）
        conn.execute(
            f"UPDATE requirements SET {','.join(fields)}, updated_at=datetime('now','localtime') WHERE id=?",
            tuple(args),
        )
        conn.commit()
        return RequirementRepo.get(conn, rid)

    @staticmethod
    def delete(conn, rid):
        sess = [row_to_dict(s)["id"] for s in
                conn.execute("SELECT id FROM sessions WHERE requirement_id=?", (rid,)).fetchall()]
        for sid in sess:
            conn.execute("DELETE FROM messages WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM sessions WHERE requirement_id=?", (rid,))
        conn.execute("DELETE FROM test_cases WHERE requirement_id=?", (rid,))
        conn.execute("DELETE FROM attachments WHERE requirement_id=?", (rid,))
        conn.execute("DELETE FROM requirement_versions WHERE requirement_id=?", (rid,))
        conn.execute("DELETE FROM requirements WHERE id=?", (rid,))
        conn.commit()


class AttachmentRepo:
    """工作流附件元信息：需求附件（case_id 为空）与用例附件共用。

    文件实体由 backend/docs.py 落到项目工作区 .janus/ 下；这里只管列表与登记，
    因此删除需求 / 用例时不需要递归清理磁盘（.janus 是平台自留地，随项目共存亡）。
    """

    @staticmethod
    def create(conn, requirement_id, case_id, filename, path, size=0):
        cur = conn.execute(
            "INSERT INTO attachments(requirement_id,case_id,filename,path,size) VALUES(?,?,?,?,?)",
            (requirement_id, case_id, filename, path, size),
        )
        conn.commit()
        return AttachmentRepo.get(conn, cur.lastrowid)

    @staticmethod
    def get(conn, aid):
        r = conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list_by_requirement(conn, requirement_id):
        return [row_to_dict(r) for r in conn.execute(
            "SELECT * FROM attachments WHERE requirement_id=? ORDER BY id",
            (requirement_id,)).fetchall()]

    @staticmethod
    def delete(conn, aid):
        cur = conn.execute("DELETE FROM attachments WHERE id=?", (aid,))
        conn.commit()
        return cur.rowcount > 0


# 版本来源：手动保存 / AI 润色后采纳 / 从历史版本回退
VERSION_SOURCES = ("manual", "ai", "revert", "create")


class RequirementVersionRepo:
    """需求文档的历史版本。

    每次内容真的发生变化时留一条不可变快照，只增不改；「回退」是把某个旧版本
    的内容重新写回需求，并**再记一条** source=revert 的版本 —— 于是回退本身
    也可追溯、可再回退，历史永不被销毁。
    """

    @staticmethod
    def create(conn, requirement_id, title, description, source="manual", note=""):
        cur = conn.execute(
            """INSERT INTO requirement_versions(requirement_id,title,description,source,note)
               VALUES(?,?,?,?,?)""",
            (requirement_id, title or "", description or "",
             source if source in VERSION_SOURCES else "manual", note or ""),
        )
        conn.commit()
        return RequirementVersionRepo.get(conn, cur.lastrowid)

    @staticmethod
    def get(conn, vid):
        r = conn.execute("SELECT * FROM requirement_versions WHERE id=?", (vid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def latest(conn, requirement_id):
        r = conn.execute(
            "SELECT * FROM requirement_versions WHERE requirement_id=? ORDER BY id DESC LIMIT 1",
            (requirement_id,),
        ).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list_by_requirement(conn, requirement_id):
        """新版在前，便于前端直接按时间倒序渲染。"""
        return [row_to_dict(r) for r in conn.execute(
            "SELECT * FROM requirement_versions WHERE requirement_id=? ORDER BY id DESC",
            (requirement_id,)).fetchall()]

    @staticmethod
    def create_if_changed(conn, requirement_id, title, description, source="manual", note=""):
        """内容与上一版一致时不落库，避免「点一次保存多一条空历史」。"""
        last = RequirementVersionRepo.latest(conn, requirement_id)
        if last and last["title"] == (title or "") and last["description"] == (description or ""):
            return None
        return RequirementVersionRepo.create(conn, requirement_id, title, description, source, note)


# 用例状态：待验证 / 通过 / 失败 / 跳过
CASE_STATUSES = ("pending", "passed", "failed", "skipped")


class TestCaseRepo:
    """功能验证阶段的正交用例表：一条用例 = 一个可勾选的验证点。"""

    @staticmethod
    def create(conn, requirement_id, title, steps="", expected="", status="pending",
               note="", source="manual", is_manual=0):
        cur = conn.execute(
            """INSERT INTO test_cases(requirement_id,title,steps,expected,status,note,source,is_manual)
               VALUES(?,?,?,?,?,?,?,?)""",
            (requirement_id, title, steps, expected, status if status in CASE_STATUSES else "pending",
             note, source, 1 if is_manual else 0),
        )
        conn.commit()
        return TestCaseRepo.get(conn, cur.lastrowid)

    @staticmethod
    def create_many(conn, requirement_id, items, source="ai"):
        """批量写入（AI 生成后用）。空标题会被跳过，返回真正落库的行。"""
        out = []
        for it in items or []:
            title = (it.get("title") or "").strip()
            if not title:
                continue
            out.append(TestCaseRepo.create(
                conn, requirement_id, title, it.get("steps") or "", it.get("expected") or "",
                it.get("status") or "pending", it.get("note") or "", it.get("source") or source,
                1 if it.get("is_manual") else 0,
            ))
        return out

    @staticmethod
    def get(conn, cid):
        r = conn.execute("SELECT * FROM test_cases WHERE id=?", (cid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list_by_requirement(conn, requirement_id):
        return [row_to_dict(r) for r in
                conn.execute("SELECT * FROM test_cases WHERE requirement_id=? ORDER BY id",
                             (requirement_id,)).fetchall()]

    @staticmethod
    def update(conn, cid, title=_UNSET, steps=_UNSET, expected=_UNSET, status=_UNSET, note=_UNSET,
               is_manual=_UNSET):
        fields = []
        args = []
        for col, val in (("title", title), ("steps", steps), ("expected", expected),
                         ("status", status), ("note", note),
                         ("is_manual", (1 if is_manual else 0) if is_manual is not _UNSET else _UNSET)):
            if val is not _UNSET:
                fields.append(f"{col}=?")
                args.append(val)
        if not fields:
            return TestCaseRepo.get(conn, cid)
        fields.append("updated_at=datetime('now')")
        args.append(cid)
        conn.execute(f"UPDATE test_cases SET {','.join(fields)} WHERE id=?", tuple(args))
        conn.commit()
        return TestCaseRepo.get(conn, cid)

    @staticmethod
    def delete(conn, cid):
        cur = conn.execute("DELETE FROM test_cases WHERE id=?", (cid,))
        conn.commit()
        return cur.rowcount > 0

    @staticmethod
    def stats(conn, requirement_id) -> dict:
        """按状态统计；结果里始终包含全部状态键，前端不必判空。

        额外给出人工项计数：manual（标了人工的用例数）与 manual_pending（人工且尚未
        勾选结果的数），供归档页展示「人工待核」。
        """
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM test_cases WHERE requirement_id=? GROUP BY status",
            (requirement_id,),
        ).fetchall()
        out = {s: 0 for s in CASE_STATUSES}
        total = 0
        for r in rows:
            key = r["status"] if r["status"] in CASE_STATUSES else "pending"
            out[key] += r["n"]
            total += r["n"]
        out["total"] = total
        out["done"] = out["passed"] + out["failed"] + out["skipped"]
        mrow = conn.execute(
            "SELECT COUNT(*) AS m, "
            "SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS mp "
            "FROM test_cases WHERE requirement_id=? AND is_manual=1",
            (requirement_id,),
        ).fetchone()
        out["manual"] = mrow["m"] or 0
        out["manual_pending"] = mrow["mp"] or 0
        return out


class TokenRepo:
    @staticmethod
    def create(conn, token, project_ids, expires_at=None, note=""):
        conn.execute(
            "INSERT INTO tokens(token,project_ids,expires_at,note) VALUES(?,?,?,?)",
            (token, json.dumps(project_ids), expires_at, note or ""),
        )
        conn.commit()

    @staticmethod
    def get(conn, tid):
        r = conn.execute("SELECT * FROM tokens WHERE id=?", (tid,)).fetchone()
        if not r:
            return None
        d = row_to_dict(r)
        d["project_ids"] = json.loads(d["project_ids"])
        return d

    @staticmethod
    def update(conn, tid, expires_at=_UNSET, note=_UNSET, clear_expiry=False):
        """部分更新：未传入的字段保持不变；clear_expiry=True 表示设为永不过期。"""
        fields = []
        args = []
        if note is not _UNSET:
            fields.append("note=?")
            args.append(note or "")
        if clear_expiry:
            fields.append("expires_at=NULL")
        elif expires_at is not _UNSET:
            fields.append("expires_at=?")
            args.append(expires_at)
        if not fields:
            return True
        args.append(tid)
        cur = conn.execute(f"UPDATE tokens SET {','.join(fields)} WHERE id=?", tuple(args))
        conn.commit()
        return cur.rowcount > 0

    @staticmethod
    def resolve(conn, token):
        r = conn.execute("SELECT * FROM tokens WHERE token=?", (token,)).fetchone()
        if not r:
            return None
        d = row_to_dict(r)
        d["project_ids"] = json.loads(d["project_ids"])
        return d

    @staticmethod
    def list(conn):
        rows = conn.execute("SELECT * FROM tokens ORDER BY id DESC").fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            d["project_ids"] = json.loads(d["project_ids"])
            out.append(d)
        return out

    @staticmethod
    def delete(conn, tid):
        conn.execute("DELETE FROM tokens WHERE id=?", (tid,))
        conn.commit()

    @staticmethod
    def delete_by_token(conn, token):
        conn.execute("DELETE FROM tokens WHERE token=?", (token,))
        conn.commit()


class SessionRepo:
    @staticmethod
    def create(conn, requirement_id, agent_id, project_id, git_branch=None):
        cur = conn.execute(
            "INSERT INTO sessions(requirement_id,agent_id,project_id,git_branch) VALUES(?,?,?,?)",
            (requirement_id, agent_id, project_id, git_branch),
        )
        conn.commit()
        return SessionRepo.get(conn, cur.lastrowid)

    @staticmethod
    def get(conn, sid):
        r = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list_by_requirement(conn, requirement_id):
        return [row_to_dict(r) for r in
                conn.execute("SELECT * FROM sessions WHERE requirement_id=? ORDER BY id",
                             (requirement_id,)).fetchall()]

    @staticmethod
    def set_agent(conn, sid, agent_id):
        """切换会话绑定的 coding agent。

        换 Agent 后旧的 CLI 外部会话无法续聊，一并清空 cli_session_id，
        下一轮消息会以新 Agent 重新起一轮。
        """
        conn.execute(
            "UPDATE sessions SET agent_id=?, cli_session_id=NULL WHERE id=?",
            (agent_id, sid),
        )
        conn.commit()
        return SessionRepo.get(conn, sid)

    @staticmethod
    def set_cli_session_id(conn, sid, external_id):
        """记录底层 CLI 首轮返回的外部会话 id，后续轮次用 --resume 续聊。

        只在从无到有（或值发生变化）时写一次，避免每轮无谓写库。空值不覆盖已有值。
        """
        if not external_id:
            return
        row = conn.execute("SELECT cli_session_id FROM sessions WHERE id=?", (sid,)).fetchone()
        if row is None or (row[0] or "") == external_id:
            return
        conn.execute("UPDATE sessions SET cli_session_id=? WHERE id=?", (external_id, sid))
        conn.commit()

    @staticmethod
    def delete(conn, sid):
        """删除会话及其消息、关联改动集（含文件明细）。不存在则返回 False。"""
        if SessionRepo.get(conn, sid) is None:
            return False
        conn.execute("DELETE FROM messages WHERE session_id=?", (sid,))
        cs_ids = [r[0] for r in conn.execute(
            "SELECT id FROM change_sets WHERE session_id=?", (sid,)).fetchall()]
        for csid in cs_ids:
            conn.execute("DELETE FROM change_files WHERE change_set_id=?", (csid,))
        if cs_ids:
            conn.execute("DELETE FROM change_sets WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM sessions WHERE id=?", (sid,))
        conn.commit()
        return True


class MessageRepo:
    @staticmethod
    def create(conn, session_id, role, pane, content, has_edit=0):
        cur = conn.execute(
            "INSERT INTO messages(session_id,role,pane,content,has_edit) VALUES(?,?,?,?,?)",
            (session_id, role, pane, content, 1 if has_edit else 0),
        )
        conn.commit()
        return cur.lastrowid

    @staticmethod
    def list_by_session(conn, session_id):
        return [row_to_dict(r) for r in
                conn.execute("SELECT * FROM messages WHERE session_id=? ORDER BY id", (session_id,)).fetchall()]


# 改动集来源：agent 跑出来的 / 用户点了回退 / 平台外的手工操作
CHANGE_SOURCES = ("agent", "revert")


class ChangeSetRepo:
    """工作区改动记录：一次 agent 运行（或一次回退）产生的文件级改动。

    change_files 里 before/after 存的是**文本内容本身**（二进制与超限文件置 NULL
    并置 binary=1），所以回退不需要重新读盘比对，也不会因为后续又被改过而失真。
    """

    @staticmethod
    def create(conn, project_id, session_id=None, requirement_id=None,
               source="agent", note="", truncated=0):
        cur = conn.execute(
            """INSERT INTO change_sets(project_id,session_id,requirement_id,source,note,truncated)
               VALUES(?,?,?,?,?,?)""",
            (project_id, session_id, requirement_id,
             source if source in CHANGE_SOURCES else "agent", note or "", 1 if truncated else 0),
        )
        conn.commit()
        return ChangeSetRepo.get(conn, cur.lastrowid)

    @staticmethod
    def add_file(conn, change_set_id, path, status, before=None, after=None, binary=0):
        conn.execute(
            """INSERT INTO change_files(change_set_id,path,status,before,after,binary)
               VALUES(?,?,?,?,?,?)""",
            (change_set_id, path, status, before, after, 1 if binary else 0),
        )
        conn.commit()

    @staticmethod
    def recount(conn, change_set_id):
        """按实际写入的文件行回填增删改计数，避免调用方算错。"""
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM change_files WHERE change_set_id=? GROUP BY status",
            (change_set_id,)).fetchall()
        counts = {"added": 0, "modified": 0, "removed": 0}
        for r in rows:
            if r["status"] in counts:
                counts[r["status"]] = r["n"]
        conn.execute(
            "UPDATE change_sets SET added=?, modified=?, removed=? WHERE id=?",
            (counts["added"], counts["modified"], counts["removed"], change_set_id))
        conn.commit()
        return ChangeSetRepo.get(conn, change_set_id)

    @staticmethod
    def get(conn, csid):
        r = conn.execute("SELECT * FROM change_sets WHERE id=?", (csid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list_files(conn, change_set_id):
        return [row_to_dict(r) for r in conn.execute(
            "SELECT * FROM change_files WHERE change_set_id=? ORDER BY path",
            (change_set_id,)).fetchall()]

    @staticmethod
    def get_file(conn, fid):
        r = conn.execute("SELECT * FROM change_files WHERE id=?", (fid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list_by_project(conn, project_id, session_id=None, limit=50):
        """按时间倒序；列表页只取元信息，文件明细走详情接口。"""
        sql = "SELECT * FROM change_sets WHERE project_id=?"
        args: list = [project_id]
        if session_id is not None:
            sql += " AND session_id=?"
            args.append(session_id)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        return [row_to_dict(r) for r in conn.execute(sql, tuple(args)).fetchall()]

    @staticmethod
    def delete_by_session(conn, session_id):
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM change_sets WHERE session_id=?", (session_id,)).fetchall()]
        for csid in ids:
            conn.execute("DELETE FROM change_files WHERE change_set_id=?", (csid,))
        conn.execute("DELETE FROM change_sets WHERE session_id=?", (session_id,))
        conn.commit()
        return len(ids)

    @staticmethod
    def delete_by_requirement(conn, requirement_id):
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM change_sets WHERE requirement_id=?", (requirement_id,)).fetchall()]
        for csid in ids:
            conn.execute("DELETE FROM change_files WHERE change_set_id=?", (csid,))
        conn.execute("DELETE FROM change_sets WHERE requirement_id=?", (requirement_id,))
        conn.commit()
        return len(ids)

    @staticmethod
    def summary_by_requirement(conn, requirement_id) -> dict:
        """该需求累计的改动概览，供归档验收汇总（非 git 项目也能有据可依）。"""
        row = conn.execute(
            """SELECT COUNT(*) AS sets,
                      COALESCE(SUM(added),0) AS added,
                      COALESCE(SUM(modified),0) AS modified,
                      COALESCE(SUM(removed),0) AS removed
               FROM change_sets WHERE requirement_id=?""",
            (requirement_id,)).fetchone()
        files = row["added"] + row["modified"] + row["removed"]
        return {"sets": row["sets"], "files": files,
                "added": row["added"], "modified": row["modified"], "removed": row["removed"]}


# ---------------- 审计：操作日志 ----------------

# 允许过滤的字段 → SQL 片段。集中在这里，列表查询与统计聚合共用同一份条件，
# 避免「列表筛了、统计没筛」这类只在页面上才看得出来的不一致。
AUDIT_FILTERS = {
    "category": "category = ?",
    "action": "action = ?",
    "status": "status = ?",
    "actor_type": "actor_type = ?",
    "project_id": "project_id = ?",
}
# 关键词命中这些列（用 LIKE 模糊匹配）
AUDIT_Q_COLUMNS = ("action", "target_name", "actor", "project_name", "detail", "error", "ip")

INVOCATION_FILTERS = {
    "source": "source = ?",
    "status": "status = ?",
    "agent_id": "agent_id = ?",
    "project_id": "project_id = ?",
    "requirement_id": "requirement_id = ?",
    "session_id": "session_id = ?",
    "actor_type": "actor_type = ?",
}
INVOCATION_Q_COLUMNS = ("agent_name", "agent_type", "model", "project_name",
                        "requirement_title", "prompt", "response", "error")


def _build_where(filters: dict, mapping: dict, q_columns: tuple) -> tuple[str, list]:
    """把过参翻译成 ``WHERE`` 子句与参数列表。

    认得的字段走等值比较；``q`` 走跨列模糊匹配；``start`` / ``end`` 按 created_at
    范围收口（调用方负责把纯日期补成 ``YYYY-MM-DD HH:MM:SS``）。未知字段直接忽略，
    前端多传参数不该让接口 500。
    """
    clauses: list[str] = []
    args: list = []
    for key, sql in mapping.items():
        val = (filters or {}).get(key)
        if val is None or val == "":
            continue
        clauses.append(sql)
        args.append(val)
    q = (filters or {}).get("q")
    if q:
        like = f"%{q}%"
        clauses.append("(" + " OR ".join(f"{c} LIKE ?" for c in q_columns) + ")")
        args.extend([like] * len(q_columns))
    if (filters or {}).get("start"):
        clauses.append("created_at >= ?")
        args.append(filters["start"])
    if (filters or {}).get("end"):
        clauses.append("created_at <= ?")
        args.append(filters["end"])
    return (" WHERE " + " AND ".join(clauses) if clauses else ""), args


class AuditLogRepo:
    """操作日志：只增不改，供审计页按条件检索。"""

    @staticmethod
    def create(conn, row: dict) -> int:
        cur = conn.execute(
            """INSERT INTO audit_logs(actor_type,actor,token_id,ip,category,action,status,
                                      target_type,target_id,target_name,project_id,project_name,
                                      detail,error)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (row.get("actor_type") or "anonymous", row.get("actor") or "", row.get("token_id"),
             row.get("ip") or "", row.get("category") or "other", row.get("action") or "",
             row.get("status") or "success", row.get("target_type") or "", row.get("target_id"),
             row.get("target_name") or "", row.get("project_id"),
             row.get("project_name") or "", row.get("detail") or "", row.get("error") or ""),
        )
        return cur.lastrowid

    @staticmethod
    def get(conn, lid):
        r = conn.execute("SELECT * FROM audit_logs WHERE id=?", (lid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def query(conn, filters=None, limit=50, offset=0) -> dict:
        """返回 ``{total, items}``；total 是过滤后的总条数，前端据此翻页。"""
        where, args = _build_where(filters, AUDIT_FILTERS, AUDIT_Q_COLUMNS)
        total = conn.execute(f"SELECT COUNT(*) FROM audit_logs{where}", tuple(args)).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM audit_logs{where} ORDER BY id DESC LIMIT ? OFFSET ?",
            tuple(args) + (limit, offset)).fetchall()
        return {"total": total, "items": [row_to_dict(r) for r in rows]}

    @staticmethod
    def stats(conn, filters=None) -> dict:
        where, args = _build_where(filters, AUDIT_FILTERS, AUDIT_Q_COLUMNS)
        r = conn.execute(
            f"""SELECT COUNT(*) AS total,
                       COALESCE(SUM(status='success'),0) AS success,
                       COALESCE(SUM(status='failure'),0) AS failure,
                       COALESCE(SUM(date(created_at) = date('now','localtime')),0) AS today,
                       COUNT(DISTINCT CASE WHEN project_id IS NOT NULL THEN project_id END) AS projects
                FROM audit_logs{where}""", tuple(args)).fetchone()
        return dict(r)

    @staticmethod
    def categories(conn) -> list:
        """现有日志里出现过的分类与条数，供前端筛选下拉直接用真实数据。"""
        rows = conn.execute(
            "SELECT category, COUNT(*) AS n FROM audit_logs GROUP BY category ORDER BY n DESC"
        ).fetchall()
        return [{"value": r["category"], "count": r["n"]} for r in rows]

    @staticmethod
    def actions(conn) -> list:
        rows = conn.execute(
            "SELECT action, COUNT(*) AS n FROM audit_logs GROUP BY action ORDER BY n DESC"
        ).fetchall()
        return [{"value": r["action"], "count": r["n"]} for r in rows]


class AgentInvocationRepo:
    """Agent 调用留痕：一次调用一条，成功与失败同样入库。"""

    @staticmethod
    def create(conn, row: dict) -> int:
        cur = conn.execute(
            """INSERT INTO agent_invocations(source,agent_id,agent_name,agent_type,model,
                    project_id,project_name,requirement_id,requirement_title,session_id,
                    actor_type,actor,status,error,timed_out,rate_limited,prompt,response,
                    event_count,elapsed_ms,prompt_tokens,completion_tokens,total_tokens,
                    tokens_estimated)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (row.get("source") or "session", row.get("agent_id"), row.get("agent_name") or "",
             row.get("agent_type") or "", row.get("model") or "", row.get("project_id"),
             row.get("project_name") or "", row.get("requirement_id"),
             row.get("requirement_title") or "", row.get("session_id"),
             row.get("actor_type") or "", row.get("actor") or "", row.get("status") or "success",
             row.get("error") or "", int(row.get("timed_out") or 0),
             int(row.get("rate_limited") or 0), row.get("prompt") or "",
             row.get("response") or "", int(row.get("event_count") or 0),
             int(row.get("elapsed_ms") or 0), row.get("prompt_tokens"),
             row.get("completion_tokens"), row.get("total_tokens"),
             int(row.get("tokens_estimated") or 0)),
        )
        return cur.lastrowid

    @staticmethod
    def get(conn, iid):
        r = conn.execute("SELECT * FROM agent_invocations WHERE id=?", (iid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def query(conn, filters=None, limit=50, offset=0) -> dict:
        where, args = _build_where(filters, INVOCATION_FILTERS, INVOCATION_Q_COLUMNS)
        total = conn.execute(
            f"SELECT COUNT(*) FROM agent_invocations{where}", tuple(args)).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM agent_invocations{where} ORDER BY id DESC LIMIT ? OFFSET ?",
            tuple(args) + (limit, offset)).fetchall()
        return {"total": total, "items": [row_to_dict(r) for r in rows]}

    @staticmethod
    def stats(conn, filters=None) -> dict:
        where, args = _build_where(filters, INVOCATION_FILTERS, INVOCATION_Q_COLUMNS)
        r = conn.execute(
            f"""SELECT COUNT(*) AS total,
                       COALESCE(SUM(status='success'),0) AS success,
                       COALESCE(SUM(status='error'),0) AS error,
                       COALESCE(SUM(timed_out),0) AS timed_out,
                       COALESCE(SUM(rate_limited),0) AS rate_limited,
                       COALESCE(SUM(total_tokens),0) AS total_tokens,
                       COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
                       COALESCE(SUM(completion_tokens),0) AS completion_tokens,
                       COALESCE(SUM(tokens_estimated),0) AS estimated_rows,
                       COALESCE(SUM(elapsed_ms),0) AS elapsed_ms,
                       COALESCE(MAX(elapsed_ms),0) AS max_elapsed_ms
                FROM agent_invocations{where}""", tuple(args)).fetchone()
        out = dict(r)
        total = out["total"] or 0
        out["avg_elapsed_ms"] = int(round((out["elapsed_ms"] or 0) / total)) if total else 0
        # 按来源拆分：能一眼看出「工作台会话 / 一键测试 / AI 任务」各占多少
        rows = conn.execute(
            f"SELECT source, COUNT(*) AS n FROM agent_invocations{where} GROUP BY source",
            tuple(args)).fetchall()
        out["by_source"] = {r["source"]: r["n"] for r in rows}
        return out
