"""通用脚本：列表、frontmatter、保存、执行传参、.runs 记录。"""
import json
import os
import tempfile
from pathlib import Path

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import docs as WD
from backend import scripts as SCR


def _db():
    conn = get_conn()
    init_db(conn)
    return conn


def _fixture(conn):
    root = tempfile.mkdtemp()
    p = R.ProjectRepo.create(conn, "proj", root)
    rq = R.RequirementRepo.create(conn, p["id"], "登录需求", "")
    conn.execute("UPDATE requirements SET dir_name='demo' WHERE id=?", (rq["id"],))
    conn.commit()
    rq = R.RequirementRepo.get(conn, rq["id"])
    return root, rq


SAMPLE = """---
name: 回显参数
desc: 打印 CLI 参数
params:
  - name: env
    label: 环境
    type: string
    default: staging
    required: true
  - name: dry_run
    label: 试跑
    type: boolean
    default: true
---
import sys
print('ARGS', sys.argv[1:])
"""


def test_list_empty():
    conn = _db()
    root, rq = _fixture(conn)
    assert SCR.list_scripts(root, rq["dir_name"]) == []


def test_write_list_read():
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    SCR.write_script(root, d, "echo.py", SAMPLE)
    items = SCR.list_scripts(root, d)
    assert len(items) == 1
    assert items[0]["name"] == "echo.py"
    assert items[0]["display_name"] == "回显参数"
    assert items[0]["desc"] == "打印 CLI 参数"
    assert [p["name"] for p in items[0]["params"]] == ["env", "dry_run"]
    one = SCR.read_script(root, d, "echo.py")
    assert "import sys" in one["body"]
    assert one["content"].startswith("---")


def test_safe_name_rejects_traversal():
    try:
        SCR.safe_name("../x.py")
        assert False, "should raise"
    except SCR.ScriptError:
        pass
    try:
        SCR.safe_name("foo.txt")
        assert False, "should raise"
    except SCR.ScriptError:
        pass


def test_parse_frontmatter_plain():
    meta, body = SCR.parse_frontmatter("print(1)\n")
    assert meta == {} and body == "print(1)\n"


def test_run_passes_cli_args_and_remembers():
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    SCR.write_script(root, d, "echo.py", SAMPLE)
    res = SCR.run_script(root, d, "echo.py", {"env": "prod", "dry_run": False})
    assert res["ran"] is True and res["exit_code"] == 0
    assert "--env" in res["output"] and "prod" in res["output"]
    assert "--dry_run" in res["output"] and "false" in res["output"]
    assert res["last_params"]["env"] == "prod"
    assert res["last_params"]["dry_run"] == "false"
    runs = SCR.list_runs(root, d, "echo.py")
    assert len(runs) >= 1 and runs[0]["params"]["env"] == "prod"
    # 再次 list 应带 last_params
    items = SCR.list_scripts(root, d)
    assert items[0]["last_params"]["env"] == "prod"


def test_run_missing_required():
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    content = (
        "---\nparams:\n  - name: env\n    type: string\n    required: true\n---\n"
        "print(1)\n"
    )
    SCR.write_script(root, d, "need.py", content)
    try:
        SCR.run_script(root, d, "need.py", {})
        assert False, "should raise"
    except SCR.ScriptError as e:
        assert "必填" in e.message


def test_delete_removes_runs():
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    SCR.write_script(root, d, "echo.py", SAMPLE)
    SCR.run_script(root, d, "echo.py", {"env": "a"})
    stem_rel = WD.script_runs_file(d, "echo")
    assert (Path(root) / stem_rel).is_file()
    SCR.delete_script(root, d, "echo.py")
    assert SCR.list_scripts(root, d) == []
    assert not (Path(root) / stem_rel).is_file()


def test_runs_cap():
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    content = "---\nname: n\n---\nprint('ok')\n"
    SCR.write_script(root, d, "n.py", content)
    for _ in range(22):
        SCR.run_script(root, d, "n.py", {})
    runs = SCR.list_runs(root, d, "n.py")
    assert len(runs) == 20
