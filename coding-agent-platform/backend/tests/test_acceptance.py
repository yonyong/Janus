"""通用总验收脚本：发现、过期判定、执行、报告标题、覆盖度、人工统计。"""
import os
import tempfile
import time
from pathlib import Path

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import acceptance as ACC
from backend import docs as WD
from backend import test_report as TR


def _db():
    conn = get_conn()
    init_db(conn)
    return conn


def _fixture(conn):
    root = tempfile.mkdtemp()
    p = R.ProjectRepo.create(conn, "proj", root)
    rq = R.RequirementRepo.create(conn, p["id"], "登录需求", "")
    # RequirementRepo.create 不落 dir_name（真实创建走 app 层），测试里显式补一个
    conn.execute("UPDATE requirements SET dir_name='demo' WHERE id=?", (rq["id"],))
    conn.commit()
    rq = R.RequirementRepo.get(conn, rq["id"])
    return root, rq


def _write(root: str, rel: str, content: str) -> str:
    ap = Path(root) / rel
    ap.parent.mkdir(parents=True, exist_ok=True)
    ap.write_text(content, encoding="utf-8")
    return str(ap)


def test_status_no_script():
    conn = _db()
    root, rq = _fixture(conn)
    st = ACC.script_status([], root, rq["dir_name"])
    assert st["exists"] is False and st["stale"] is False and st["name"] is None


def test_status_stale_by_case_update():
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    script = _write(root, WD.accept_script(d), "print('hi')\n")
    # 脚本 mtime 设到过去，用例更新在其后 → 过期
    old = time.time() - 3600
    os.utime(script, (old, old))
    c = R.TestCaseRepo.create(conn, rq["id"], "用例A")
    st = ACC.script_status([c], root, d)
    assert st["exists"] is True and st["lang"] == "python3"
    assert st["stale"] is True, "用例晚于脚本应判过期"
    # 脚本 mtime 设到将来 → 不过期
    future = time.time() + 3600
    os.utime(script, (future, future))
    st2 = ACC.script_status([c], root, d)
    assert st2["stale"] is False


def test_run_script_python_and_sync():
    conn = _db()
    root, rq = _fixture(conn)
    d = rq["dir_name"]
    rid = rq["id"]
    c1 = R.TestCaseRepo.create(conn, rid, "正确密码可登录")
    c2 = R.TestCaseRepo.create(conn, rid, "错误密码提示")
    # accept.py 写一张结果表：用例1 通过、用例2 失败
    report_rel = WD.test_result_doc(d)
    script = (
        "import os\n"
        "os.makedirs(os.path.dirname(r'" + report_rel + "'), exist_ok=True)\n"
        "open(r'" + report_rel + "','w',encoding='utf-8').write('''| 用例 | 标题 | 结果 | 说明 |\n"
        "| --- | --- | --- | --- |\n"
        "| 01 | 正确密码可登录 | 通过 | 12ms |\n"
        "| 02 | 错误密码提示 | 失败 | 未弹提示 |\n''')\n"
        "print('acceptance done')\n"
    )
    _write(root, WD.accept_script(d), script)
    res = ACC.run_script(root, d)
    assert res["ran"] is True and res["exit_code"] == 0
    assert "acceptance done" in res["output"]
    # 报告已生成 → sync 回写用例状态
    sync = TR.sync_cases(conn, rid, root, d)
    assert sync["found"] is True and sync["updated"] == 2
    assert R.TestCaseRepo.get(conn, c1["id"])["status"] == "passed"
    assert R.TestCaseRepo.get(conn, c2["id"])["status"] == "failed"


def test_run_script_missing():
    conn = _db()
    root, rq = _fixture(conn)
    res = ACC.run_script(root, rq["dir_name"])
    assert res["ran"] is False and res["reason"] == "no_script"


def test_report_titles_and_parse():
    content = (
        "| 用例 | 标题 | 结果 | 说明 |\n"
        "| --- | --- | --- | --- |\n"
        "| 01 | 正确密码可登录 | 通过 | |\n"
        "| 02 | 错误密码提示 | 失败 | |\n"
    )
    titles = TR.report_titles(content)
    assert titles == {"正确密码可登录", "错误密码提示"}
    # 无标题列时返回空集（覆盖度未知）
    no_title = "| 用例 | 结果 |\n| --- | --- |\n| 01 | 通过 |\n"
    assert TR.report_titles(no_title) == set()


def test_stats_manual_counts():
    conn = _db()
    root, rq = _fixture(conn)
    rid = rq["id"]
    R.TestCaseRepo.create(conn, rid, "自动项")
    m1 = R.TestCaseRepo.create(conn, rid, "目视样式A", is_manual=1)
    R.TestCaseRepo.create(conn, rid, "目视样式B", is_manual=1)
    st = R.TestCaseRepo.stats(conn, rid)
    assert st["manual"] == 2 and st["manual_pending"] == 2
    # 勾一条人工通过 → manual_pending 减一
    R.TestCaseRepo.update(conn, m1["id"], status="passed")
    st2 = R.TestCaseRepo.stats(conn, rid)
    assert st2["manual"] == 2 and st2["manual_pending"] == 1


def test_export_marks_manual():
    conn = _db()
    root, rq = _fixture(conn)
    rid = rq["id"]
    R.TestCaseRepo.create(conn, rid, "自动项")
    R.TestCaseRepo.create(conn, rid, "人工项", is_manual=1)
    cases = R.TestCaseRepo.list_by_requirement(conn, rid)
    md = WD.export_test_cases(cases, [], rq["dir_name"])
    assert "- 人工：否" in md and "- 人工：是" in md
    assert "总验收脚本" in md
