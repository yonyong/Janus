"""访问令牌签发/校验 + 目录白名单。"""
import os
import secrets
import datetime
from . import repositories as R


class TokenService:
    @staticmethod
    def issue(conn, project_ids, ttl_days=None):
        tok = secrets.token_urlsafe(24)
        exp = None
        if ttl_days:
            exp = (datetime.datetime.now() + datetime.timedelta(days=ttl_days)).isoformat()
        R.TokenRepo.create(conn, tok, list(project_ids), exp)
        return tok

    @staticmethod
    def resolve(conn, token):
        if not token:
            return None
        row = R.TokenRepo.resolve(conn, token)
        if not row:
            return None
        if row.get("expires_at"):
            try:
                if datetime.datetime.fromisoformat(row["expires_at"]) < datetime.datetime.now():
                    return None
            except ValueError:
                pass
        return {"project_ids": row["project_ids"]}


class whitelist:
    """真实路径前缀校验，仅允许落在映射项目目录内（含解析 ../ 与符号链接）。"""

    @staticmethod
    def check(project_disk_path: str, candidate: str) -> bool:
        base = os.path.realpath(project_disk_path)
        target = os.path.realpath(candidate)
        return target == base or target.startswith(base + os.sep)
