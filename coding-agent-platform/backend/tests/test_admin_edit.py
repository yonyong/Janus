"""管理员编辑项目信息 / Agent 配置的测试。

编辑与新建、删除同属管理类动作：只有持管理员口令的管理员能做，且必须做输入校验
（空名称、不存在的磁盘路径、重名）。这里直接调用路由函数验证业务规则，
另外用一条结构性断言确认两个 PATCH 路由确实挂在 require_admin 依赖上。
"""
import json
import tempfile

from fastapi import HTTPException

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import app as A
from backend.models import AgentUpdate, ProjectUpdate


def _conn():
    conn = get_conn()
    init_db(conn)
    return conn


def _tmpdir() -> str:
    return tempfile.mkdtemp()


def _expect_http(fn, code: int):
    """断言调用抛出指定状态码的 HTTPException。"""
    try:
        fn()
    except HTTPException as e:
        assert e.status_code == code, f"期望 {code}，实际 {e.status_code}：{e.detail}"
    else:
        raise AssertionError(f"期望 HTTPException({code})，但没有抛出")


# ---------------- 项目编辑 ----------------

def test_project_update_changes_only_sent_fields():
    """只改传入的字段：改了名称，磁盘路径须保持原样。"""
    conn = _conn()
    p = R.ProjectRepo.create(conn, "旧名", _tmpdir())
    out = A.update_project(p["id"], ProjectUpdate(name="新名"), conn)
    assert out["name"] == "新名"
    assert out["disk_path"] == p["disk_path"], "未传入的 disk_path 不该被改动"
    conn.close()


def test_project_update_can_change_disk_path():
    conn = _conn()
    p = R.ProjectRepo.create(conn, "demo", _tmpdir())
    new_path = _tmpdir()
    out = A.update_project(p["id"], ProjectUpdate(disk_path=new_path), conn)
    assert out["disk_path"] == new_path
    assert out["name"] == "demo"
    conn.close()


def test_project_update_rejects_blank_name():
    conn = _conn()
    p = R.ProjectRepo.create(conn, "demo", _tmpdir())
    _expect_http(lambda: A.update_project(p["id"], ProjectUpdate(name="   "), conn), 400)
    # 被拒后库里的值不受影响
    assert R.ProjectRepo.get(conn, p["id"])["name"] == "demo"
    conn.close()


def test_project_update_rejects_missing_directory():
    """路径不存在时拒绝：否则项目会被改成必然报错的死路径。"""
    conn = _conn()
    p = R.ProjectRepo.create(conn, "demo", _tmpdir())
    bad = str(_tmpdir()) + "/no-such-subdir"
    _expect_http(lambda: A.update_project(p["id"], ProjectUpdate(disk_path=bad), conn), 400)
    assert R.ProjectRepo.get(conn, p["id"])["disk_path"] == p["disk_path"]
    conn.close()


def test_project_update_missing_project_is_404():
    conn = _conn()
    _expect_http(lambda: A.update_project(9999, ProjectUpdate(name="x"), conn), 404)
    conn.close()


# ---------------- Agent 编辑 ----------------

def test_agent_update_changes_name_type_and_config():
    conn = _conn()
    a = R.AgentRepo.create(conn, "cb", "fake", {"cmd": "old"})
    out = A.update_agent(a["id"], AgentUpdate(name="cb-2", type="codebuddy",
                                              config={"cmd": "codebuddy"}), conn)
    assert out["name"] == "cb-2"
    assert out["type"] == "codebuddy"
    # config 以 JSON 文本落库，读回应还原成同一条配置
    assert json.loads(out["config"]) == {"cmd": "codebuddy"}
    conn.close()


def test_agent_update_keeps_untouched_fields():
    conn = _conn()
    a = R.AgentRepo.create(conn, "cb", "codebuddy", {"cmd": "codebuddy"})
    out = A.update_agent(a["id"], AgentUpdate(name="cb-renamed"), conn)
    assert out["name"] == "cb-renamed"
    assert out["type"] == "codebuddy"
    assert json.loads(out["config"]) == {"cmd": "codebuddy"}
    conn.close()


def test_agent_update_empty_body_is_noop():
    """空 body 不该把字段清空，也不该报错。"""
    conn = _conn()
    a = R.AgentRepo.create(conn, "cb", "codebuddy", {"cmd": "codebuddy"})
    out = A.update_agent(a["id"], AgentUpdate(), conn)
    assert out["name"] == "cb" and out["type"] == "codebuddy"
    conn.close()


def test_agent_update_rejects_blank_name_and_type():
    conn = _conn()
    a = R.AgentRepo.create(conn, "cb", "codebuddy", {})
    _expect_http(lambda: A.update_agent(a["id"], AgentUpdate(name="  "), conn), 400)
    _expect_http(lambda: A.update_agent(a["id"], AgentUpdate(type=""), conn), 400)
    # 被拒后原值不变
    assert R.AgentRepo.get(conn, a["id"])["name"] == "cb"
    conn.close()


def test_agent_update_duplicate_name_conflicts():
    conn = _conn()
    R.AgentRepo.create(conn, "taken", "fake", {})
    a = R.AgentRepo.create(conn, "cb", "fake", {})
    _expect_http(lambda: A.update_agent(a["id"], AgentUpdate(name="taken"), conn), 409)
    assert R.AgentRepo.get(conn, a["id"])["name"] == "cb"
    conn.close()


def test_agent_update_missing_agent_is_404():
    conn = _conn()
    _expect_http(lambda: A.update_agent(9999, AgentUpdate(name="x"), conn), 404)
    conn.close()


# ---------------- 权限接线 ----------------

def test_edit_routes_are_guarded_by_admin():
    """两个编辑路由必须挂在 require_admin 上。

    路由函数直接调用会绕过 FastAPI 的依赖注入，所以这里检查路由表本身：
    一旦有人把 _ok=Depends(require_admin) 删掉，持访问令牌的业务人员就能改项目磁盘映射。
    """
    def deps_of(path: str, method: str):
        for r in A.app.routes:
            if getattr(r, "path", None) == path and method in (getattr(r, "methods", None) or set()):
                return [d.call for d in r.dependant.dependencies]
        raise AssertionError(f"未找到路由 {method} {path}")

    assert A.require_admin in deps_of("/api/projects/{pid}", "PATCH")
    # 管理台前缀与管理台页面的增删保持同一套守卫
    assert A.require_admin in deps_of("/api/admin/projects/{pid}", "PATCH")
    assert A.require_admin in deps_of("/api/agents/{aid}", "PATCH")
