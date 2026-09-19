"""访问令牌签发/校验 + 目录白名单。"""
import os
import secrets
import datetime
from . import repositories as R


class TokenExpiryError(ValueError):
    """有效期参数非法（过期时刻已过去，或日期串无法解析）。"""


def compute_expiry(ttl_days=None, expires_at=None):
    """把「N 天后过期」与「指定时刻过期」归一成 ISO 时间串。

    两者都给时以 expires_at 为准；都没给返回 None，表示永不过期。
    """
    if expires_at:
        try:
            dt = datetime.datetime.fromisoformat(str(expires_at).strip().replace("Z", "+00:00"))
        except ValueError:
            raise TokenExpiryError(f"无法解析的过期时间: {expires_at}")
        # fromisoformat 可能带 tzinfo，统一转成 naive 本地时间与 datetime.now() 对齐
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        if dt <= datetime.datetime.now():
            raise TokenExpiryError("过期时间必须晚于当前时间")
        return dt.isoformat(timespec="seconds")
    if ttl_days:
        try:
            days = float(ttl_days)
        except (TypeError, ValueError):
            raise TokenExpiryError(f"无效的有效期天数: {ttl_days}")
        if days <= 0:
            return None
        return (datetime.datetime.now() + datetime.timedelta(days=days)).isoformat(timespec="seconds")
    return None


class TokenService:
    @staticmethod
    def issue(conn, project_ids, ttl_days=None, expires_at=None, note=""):
        tok = secrets.token_urlsafe(24)
        exp = compute_expiry(ttl_days, expires_at)
        R.TokenRepo.create(conn, tok, list(project_ids), exp, note)
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
