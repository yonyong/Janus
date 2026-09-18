"""各实体的 CRUD 数据访问层（sqlite3 + sqlite3.Row）。"""
import json
from .db import row_to_dict


class AgentRepo:
    @staticmethod
    def create(conn, name, type_, config):
        cfg = config if isinstance(config, str) else json.dumps(config, ensure_ascii=False)
        cur = conn.execute("INSERT INTO agents(name,type,config) VALUES(?,?,?)", (name, type_, cfg))
        conn.commit()
        return AgentRepo.get(conn, cur.lastrowid)

    @staticmethod
    def get(conn, aid):
        r = conn.execute("SELECT * FROM agents WHERE id=?", (aid,)).fetchone()
        return row_to_dict(r) if r else None

    @staticmethod
    def list(conn):
        return [row_to_dict(r) for r in conn.execute("SELECT * FROM agents ORDER BY id").fetchall()]

    @staticmethod
    def delete(conn, aid):
        conn.execute("DELETE FROM agents WHERE id=?", (aid,))
        conn.commit()


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
    def delete(conn, pid):
        conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        conn.commit()


class RequirementRepo:
    @staticmethod
    def create(conn, project_id, title, description=""):
        cur = conn.execute(
            "INSERT INTO requirements(project_id,title,description) VALUES(?,?,?)",
            (project_id, title, description),
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
    def delete(conn, rid):
        sess = [row_to_dict(s)["id"] for s in
                conn.execute("SELECT id FROM sessions WHERE requirement_id=?", (rid,)).fetchall()]
        for sid in sess:
            conn.execute("DELETE FROM messages WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM sessions WHERE requirement_id=?", (rid,))
        conn.execute("DELETE FROM requirements WHERE id=?", (rid,))
        conn.commit()


class TokenRepo:
    @staticmethod
    def create(conn, token, project_ids, expires_at=None):
        conn.execute("INSERT INTO tokens(token,project_ids,expires_at) VALUES(?,?,?)",
                     (token, json.dumps(project_ids), expires_at))
        conn.commit()

    @staticmethod
    def resolve(conn, token):
        r = conn.execute("SELECT * FROM tokens WHERE token=?", (token,)).fetchone()
        if not r:
            return None
        d = row_to_dict(r)
        d["project_ids"] = json.loads(d["project_ids"])
        return d


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
