"""令牌与目录白名单测试。"""
from backend.db import get_conn, init_db
from backend import auth


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
