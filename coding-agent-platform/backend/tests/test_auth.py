"""令牌、统一认证解析与目录白名单测试。"""
from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import auth, repositories as R
from backend import app as A
from backend.config import CONFIG


def test_token_roundtrip():
    conn = get_conn(); init_db(conn)
    tok = auth.TokenService.issue(conn, [1, 2])
    assert auth.TokenService.resolve(conn, tok)["project_ids"] == [1, 2]
    assert auth.TokenService.resolve(conn, "nope") is None
    conn.close()


def test_whitelist():
    assert auth.whitelist.check("/projects/foo", "/projects/foo/src/a.py") is True
    assert auth.whitelist.check("/projects/foo", "/projects/bar/x.py") is False
    assert auth.whitelist.check("/projects/foo", "/projects/foo/../bar/x.py") is False


def test_resolve_access_scopes_by_token():
    """访问令牌只放行被授权项目；无凭证或不存在的令牌返回 None（由调用方转 401）。"""
    conn = get_conn(); init_db(conn)
    p1 = R.ProjectRepo.create(conn, "p1", "/tmp/p1")
    p2 = R.ProjectRepo.create(conn, "p2", "/tmp/p2")
    tok = auth.TokenService.issue(conn, [p1["id"]])

    allowed = A.resolve_access(conn, tok, None)
    assert allowed == {p1["id"]}
    assert p2["id"] not in allowed
    assert A.resolve_access(conn, None, None) is None
    assert A.resolve_access(conn, "not-a-real-token", None) is None
    conn.close()


def test_resolve_access_admin_sees_all_projects():
    """管理员口令有效即授予全部项目：管理员不该被迫再额外持有一枚分享令牌。"""
    conn = get_conn(); init_db(conn)
    p1 = R.ProjectRepo.create(conn, "a", "/tmp/a")
    p2 = R.ProjectRepo.create(conn, "b", "/tmp/b")

    old = CONFIG.admin_token
    CONFIG.admin_token = "secret-xyz"
    try:
        assert A.resolve_access(conn, None, "secret-xyz") == {p1["id"], p2["id"]}
        # 口令不对时既不授予全量，也不因为「有 admin 参数」就放行
        assert A.resolve_access(conn, None, "wrong") is None
    finally:
        CONFIG.admin_token = old
        conn.close()


def test_admin_verify_rejects_when_not_configured():
    """未配置 CAP_ADMIN_TOKEN 时，管理员登录必须明确回 400，
    而不是像 require_admin 那样放行——否则任何口令都能「登录成功」。"""
    old = CONFIG.admin_token
    CONFIG.admin_token = ""
    try:
        try:
            A.admin_verify(admin="anything")
        except HTTPException as e:
            assert e.status_code == 400
        else:
            raise AssertionError("开放模式下不该放行任意管理员口令")
    finally:
        CONFIG.admin_token = old


def test_admin_verify_checks_password():
    """管理员登录接口：口令正确才通过，错误或缺失一律 401。"""
    old = CONFIG.admin_token
    CONFIG.admin_token = "secret-xyz"
    try:
        assert A.admin_verify(admin="secret-xyz")["ok"] is True
        for bad in ("wrong", None, ""):
            try:
                A.admin_verify(admin=bad)
            except HTTPException as e:
                assert e.status_code == 401, f"{bad!r} 应被拒绝"
            else:
                raise AssertionError(f"{bad!r} 不该通过管理员校验")
    finally:
        CONFIG.admin_token = old


def test_create_requirement_route_requires_admin():
    """新建需求仅管理员可调用：与新建项目同一套 require_admin 守卫。

    路由函数直接调用会绕过 FastAPI 依赖注入，因此检查路由表本身。
    """
    def deps_of(path: str, method: str):
        for r in A.app.routes:
            if getattr(r, "path", None) == path and method in (getattr(r, "methods", None) or set()):
                return [d.call for d in r.dependant.dependencies]
        raise AssertionError(f"未找到路由 {method} {path}")

    assert A.require_admin in deps_of("/api/projects/{pid}/requirements", "POST")
    assert A.require_admin in deps_of("/api/projects", "POST")
