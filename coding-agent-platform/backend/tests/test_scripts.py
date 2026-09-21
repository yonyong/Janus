"""通用脚本：列表、frontmatter、保存、执行传参、.runs 记录。"""
import tempfile
from pathlib import Path

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import docs as WD
from backend import scripts as SCR
from backend import script_proc as SP


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


def test_select_param_options_and_reject_unknown():
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    content = """---
name: 服务控制
params:
  - name: action
    label: 动作
    type: select
    options: [启动, 停止]
    default: 启动
    required: true
---
import sys
print('ARGS', sys.argv[1:])
"""
    SCR.write_script(root, d, "svc.py", content)
    item = SCR.list_scripts(root, d)[0]
    action = next(p for p in item["params"] if p["name"] == "action")
    assert action["type"] == "select"
    assert action["options"] == [
        {"value": "启动", "label": "启动"},
        {"value": "停止", "label": "停止"},
    ]
    res = SCR.run_script(root, d, "svc.py", {"action": "停止"})
    assert res["ran"] is True and res["exit_code"] == 0
    assert "--action" in res["output"] and "停止" in res["output"]
    try:
        SCR.run_script(root, d, "svc.py", {"action": "重启"})
        assert False, "should raise"
    except SCR.ScriptError as e:
        assert "只能选择" in e.message


def test_select_accepts_labeled_options():
    meta, _ = SCR.parse_frontmatter(
        "---\nparams:\n  - name: mode\n    type: enum\n    options:\n"
        "      - value: start\n        label: 启动\n"
        "      - value: stop\n        label: 停止\n---\nprint(1)\n"
    )
    params = SCR._normalize_params(meta)
    assert params[0]["type"] == "select"
    assert params[0]["options"][0] == {"value": "start", "label": "启动"}
    assert params[0]["options"][1]["value"] == "stop"


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


def test_run_chinese_stdout_survives_utf8_contract():
    """中文 stdout 在 UTF-8 父子契约下完整进 .runs（不因 locale 解码失败变空）。"""
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    content = (
        "---\nname: zh\n---\n"
        "print('未同步')\n"
        "print('原始文件没有同步', flush=True)\n"
    )
    SCR.write_script(root, d, "zh.py", content)
    res = SCR.run_script(root, d, "zh.py", {})
    assert res["ran"] is True and res["exit_code"] == 0
    assert "未同步" in res["output"]
    assert "原始文件没有同步" in res["output"]
    runs = SCR.list_runs(root, d, "zh.py")
    assert runs[0]["output"] and "未同步" in runs[0]["output"]


def test_run_merges_janus_script_log_when_pipe_empty():
    """脚本只写 JANUS_SCRIPT_LOG、不 print 时，平台仍能从副通道回读。"""
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    content = (
        "---\nname: logonly\n---\n"
        "import os\n"
        "p = os.environ['JANUS_SCRIPT_LOG']\n"
        "open(p, 'a', encoding='utf-8').write('[结果] 仅日志文件\\n')\n"
    )
    SCR.write_script(root, d, "logonly.py", content)
    res = SCR.run_script(root, d, "logonly.py", {})
    assert res["ran"] is True and res["exit_code"] == 0
    assert "[结果] 仅日志文件" in res["output"]


def test_build_script_env_forces_python_utf8():
    env = SP.build_script_env("/tmp/x.log")
    assert env["PYTHONUTF8"] == "1"
    assert env["PYTHONIOENCODING"] == "utf-8"
    assert env["JANUS_SCRIPT_LOG"] == "/tmp/x.log"


def test_merge_replaces_undecodable_via_errors_replace():
    """非法 UTF-8 字节不应抛错，应以 replace 进合并结果。"""
    bad = b"ok\xff\xfe" + "中文".encode("utf-8")
    out = SP.merge_script_output(bad, None, None)
    assert "ok" in out
    assert "\ufffd" in out
    assert "中文" in out
