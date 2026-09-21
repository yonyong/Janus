"""管理台批量删除：项目 / 令牌 / 会话。

约定与用例批量删除一致：先整批校验存在性，任一条不合格则整批不动；
通过后逐条删除并与单删共用同一套落库逻辑。
"""
import tempfile
import uuid

from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import app as A
from backend.models import BatchIdsIn


def _conn():
    conn = get_conn()
    init_db(conn)
    return conn


def _tmpdir() -> str:
    return tempfile.mkdtemp()


def _uid() -> str:
    return uuid.uuid4().hex[:10]


def _expect_http(fn, code: int):
    try:
        fn()
    except HTTPException as e:
        assert e.status_code == code, f"期望 {code}，实际 {e.status_code}：{e.detail}"
    else:
        raise AssertionError(f"期望 HTTPException({code})，但没有抛出")


def test_batch_delete_projects_all_or_nothing():
    conn = _conn()
    u = _uid()
    a = R.ProjectRepo.create(conn, f"A-{u}", _tmpdir())
    b = R.ProjectRepo.create(conn, f"B-{u}", _tmpdir())
    # 含一个不存在的 id：整批不动
    _expect_http(
        lambda: A.admin_batch_delete_projects(BatchIdsIn(ids=[a["id"], 99999999, b["id"]]), conn),
        404,
    )
    assert R.ProjectRepo.get(conn, a["id"]) is not None
    assert R.ProjectRepo.get(conn, b["id"]) is not None
    out = A.admin_batch_delete_projects(BatchIdsIn(ids=[a["id"], b["id"]]), conn)
    assert out["deleted"] == 2
    assert R.ProjectRepo.get(conn, a["id"]) is None
    assert R.ProjectRepo.get(conn, b["id"]) is None
    conn.close()


def test_batch_delete_projects_rejects_empty():
    conn = _conn()
    _expect_http(lambda: A.admin_batch_delete_projects(BatchIdsIn(ids=[]), conn), 400)
    conn.close()


def test_batch_revoke_tokens():
    conn = _conn()
    u = _uid()
    p = R.ProjectRepo.create(conn, f"tok-proj-{u}", _tmpdir())
    t1 = f"tok-{u}-aaaaaaaa"
    t2 = f"tok-{u}-bbbbbbbb"
    R.TokenRepo.create(conn, t1, [p["id"]], note="a")
    R.TokenRepo.create(conn, t2, [p["id"]], note="b")
    rows = [t for t in R.TokenRepo.list(conn) if t["token"] in (t1, t2)]
    assert len(rows) == 2
    ids = [t["id"] for t in rows]
    out = A.admin_batch_revoke_tokens(BatchIdsIn(ids=ids), conn)
    assert out["deleted"] == 2
    for tid in ids:
        assert R.TokenRepo.get(conn, tid) is None
    conn.close()


def test_batch_delete_sessions_clears_messages():
    conn = _conn()
    u = _uid()
    p = R.ProjectRepo.create(conn, f"sess-proj-{u}", _tmpdir())
    agent = R.AgentRepo.create(conn, f"fake-batch-sess-{u}", "fake", {})
    req = R.RequirementRepo.create(conn, p["id"], f"需求-{u}", "")
    s1 = R.SessionRepo.create(conn, req["id"], agent["id"], p["id"])
    s2 = R.SessionRepo.create(conn, req["id"], agent["id"], p["id"])
    R.MessageRepo.create(conn, s1["id"], "user", "req", "hello")
    R.MessageRepo.create(conn, s2["id"], "user", "req", "world")
    out = A.admin_batch_delete_sessions(BatchIdsIn(ids=[s1["id"], s2["id"]]), conn)
    assert out["deleted"] == 2
    assert R.SessionRepo.get(conn, s1["id"]) is None
    assert R.SessionRepo.get(conn, s2["id"]) is None
    assert R.MessageRepo.list_by_session(conn, s1["id"]) == []
    assert R.MessageRepo.list_by_session(conn, s2["id"]) == []
    conn.close()


def test_delete_session_single():
    conn = _conn()
    u = _uid()
    p = R.ProjectRepo.create(conn, f"one-sess-{u}", _tmpdir())
    agent = R.AgentRepo.create(conn, f"fake-one-sess-{u}", "fake", {})
    req = R.RequirementRepo.create(conn, p["id"], f"需求-{u}", "")
    s = R.SessionRepo.create(conn, req["id"], agent["id"], p["id"])
    R.MessageRepo.create(conn, s["id"], "user", "req", "hi")
    A.admin_delete_session(s["id"], conn)
    assert R.SessionRepo.get(conn, s["id"]) is None
    conn.close()
