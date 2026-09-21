"""令牌备注 / 有效期（1天/3天/7天/指定日期/永不过期）/ 查看原文 / 过期校验 / 非法入参。

不依赖 httpx：直接调用 app 路由函数（FastAPI Depends 只是普通参数的默认值，
显式传入 db / request / _ok 即可绕过依赖注入），覆盖签发、查看、更新三条端点，
以及 auth.compute_expiry 与 TokenService.resolve 的过期判定。
"""
import datetime

from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import auth
from backend import app as app_module
from backend.models import AdminTokenIssue, AdminTokenUpdate


def _new(conn):
    conn.execute("DELETE FROM tokens")
    conn.execute("DELETE FROM projects")
    conn.commit()


def _make_project(conn, name="demo"):
    return R.ProjectRepo.create(conn, name, f"/tmp/{name}")["id"]


# ---------------- 有效期四种模式 + 永不过期 ----------------

def test_compute_expiry_modes():
    now = datetime.datetime.now()
    # 1/3/7 天：截断到秒，与 now+Nd 偏差应在 1s 内
    for d in (1, 3, 7):
        exp = auth.compute_expiry(d, None)
        dt = datetime.datetime.fromisoformat(exp)
        diff = abs((dt - (now + datetime.timedelta(days=d))).total_seconds())
        assert diff < 5, f"ttl_days={d} 偏差过大: {diff}s"
    # 指定日期时刻
    fixed = "2027-03-15T08:30:00"
    assert auth.compute_expiry(None, fixed) == fixed
    # 永不过期：都不传返回 None
    assert auth.compute_expiry(None, None) is None
    # 两者都传以 expires_at 为准
    assert auth.compute_expiry(7, fixed) == fixed


def test_compute_expiry_invalid():
    # 过期时刻已过去
    past = (datetime.datetime.now() - datetime.timedelta(days=1)).isoformat(timespec="seconds")
    try:
        auth.compute_expiry(None, past)
        assert False, "过去的过期时间应被拒绝"
    except auth.TokenExpiryError:
        pass
    # 无法解析
    try:
        auth.compute_expiry(None, "not-a-date")
        assert False, "非法日期应被拒绝"
    except auth.TokenExpiryError:
        pass


# ---------------- 备注 ----------------

def test_issue_with_note():
    conn = get_conn(); init_db(conn); _new(conn)
    pid = _make_project(conn)
    r = app_module.admin_issue_token(
        AdminTokenIssue(project_ids=[pid], note="给张三临时试用"), db=conn, _ok=True
    )
    assert r["note"] == "给张三临时试用"
    # 列表与原文查看都应带回备注
    listed = app_module.admin_tokens(db=conn, _ok=True)
    assert listed[0]["note"] == "给张三临时试用"
    revealed = app_module.admin_reveal_token(tid=listed[0]["id"], db=conn, _ok=True)
    assert revealed["note"] == "给张三临时试用"


# ---------------- 查看已签发令牌原文（不再只在签发瞬间可见） ----------------

def test_reveal_full_token():
    conn = get_conn(); init_db(conn); _new(conn)
    pid = _make_project(conn)
    r = app_module.admin_issue_token(
        AdminTokenIssue(project_ids=[pid], note="n"), db=conn, _ok=True
    )
    tok = r["token"]
    revealed = app_module.admin_reveal_token(tid=r["id"], db=conn, _ok=True)
    assert revealed["token"] == tok
    assert revealed["link"].endswith(f"?token={tok}")
    # 不存在的令牌返回 404
    try:
        app_module.admin_reveal_token(tid=99999, db=conn, _ok=True)
        assert False, "不存在的令牌应 404"
    except HTTPException as e:
        assert e.status_code == 404


# ---------------- 过期校验 ----------------

def test_expired_token_rejected():
    conn = get_conn(); init_db(conn); _new(conn)
    past = (datetime.datetime.now() - datetime.timedelta(days=1)).isoformat(timespec="seconds")
    tok = "expired-token-value"
    R.TokenRepo.create(conn, tok, [1], past, "old")
    # 已过期：resolve 视为无效
    assert auth.TokenService.resolve(conn, tok) is None
    # 未过期：resolve 通过
    future = (datetime.datetime.now() + datetime.timedelta(days=1)).isoformat(timespec="seconds")
    tok2 = "valid-token-value"
    R.TokenRepo.create(conn, tok2, [1], future, "new")
    assert auth.TokenService.resolve(conn, tok2)["project_ids"] == [1]


# ---------------- 更新备注与有效期 ----------------

def test_update_note_and_expiry():
    conn = get_conn(); init_db(conn); _new(conn)
    pid = _make_project(conn)
    r = app_module.admin_issue_token(
        AdminTokenIssue(project_ids=[pid], note="原备注", ttl_days=7), db=conn, _ok=True
    )
    tid = r["id"]

    # 仅改备注：有效期保持不变
    up = app_module.admin_update_token(
        tid, AdminTokenUpdate(note="改后备注"), db=conn, _ok=True
    )
    assert up["note"] == "改后备注"
    assert up["expires_at"] is not None

    # 改为指定日期
    fixed = "2028-12-31T23:59:00"
    up = app_module.admin_update_token(
        tid, AdminTokenUpdate(expires_at=fixed), db=conn, _ok=True
    )
    assert up["expires_at"] == fixed
    assert up["note"] == "改后备注"

    # 改为永不过期
    up = app_module.admin_update_token(
        tid, AdminTokenUpdate(never_expires=True), db=conn, _ok=True
    )
    assert up["expires_at"] is None
    assert up["note"] == "改后备注"


def test_update_invalid_expiry_400():
    conn = get_conn(); init_db(conn); _new(conn)
    pid = _make_project(conn)
    r = app_module.admin_issue_token(
        AdminTokenIssue(project_ids=[pid], note="n"), db=conn, _ok=True
    )
    try:
        app_module.admin_update_token(
            r["id"], AdminTokenUpdate(expires_at="2020-01-01T00:00:00"), db=conn, _ok=True
        )
        assert False, "过去的有效期应返回 400"
    except HTTPException as e:
        assert e.status_code == 400
