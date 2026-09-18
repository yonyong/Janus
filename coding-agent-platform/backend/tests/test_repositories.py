"""仓储层测试（pytest 风格，亦可由 run_all.py 在无 pytest 环境运行）。"""
from backend.db import get_conn, init_db
from backend import repositories as R


def test_agent_crud():
    conn = get_conn(); init_db(conn)
    a = R.AgentRepo.create(conn, "cb", "codebuddy", {"cmd": "codebuddy"})
    assert R.AgentRepo.get(conn, a["id"])["name"] == "cb"
    assert R.AgentRepo.list(conn)[0]["type"] == "codebuddy"
    raised = False
    try:
        R.AgentRepo.create(conn, "cb", "codebuddy", "{}")
    except Exception:
        raised = True
    assert raised, "重名应冲突"
    conn.close()


def test_project_requirement():
    conn = get_conn(); init_db(conn)
    p = R.ProjectRepo.create(conn, "demo", "/tmp/demo")
    r = R.RequirementRepo.create(conn, p["id"], "登录", "描述")
    assert R.RequirementRepo.list_by_project(conn, p["id"])[0]["title"] == "登录"
    R.RequirementRepo.delete(conn, r["id"])
    assert R.RequirementRepo.list_by_project(conn, p["id"]) == []
    # 令牌范围过滤
    R.ProjectRepo.create(conn, "x", "/tmp/x")
    assert len(R.ProjectRepo.list(conn, allowed_ids=[p["id"]])) == 1
    conn.close()
