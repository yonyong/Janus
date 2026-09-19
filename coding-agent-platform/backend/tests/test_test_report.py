"""测试报告解析与状态回写：表格格式、序号补位、关键词容错、同步边界。

归档验收页的统计读库里的 test_case.status，Agent 只写工作区报告——
test_report.sync_cases 是两者之间唯一的同步链路，解析规则的每个分支都值得单测。
"""
import os
import tempfile

from backend.db import get_conn, init_db
from backend import repositories as R
from backend import test_report as TR


def _db():
    conn = get_conn()
    init_db(conn)
    return conn


def _fixture_with_cases(conn, n=3):
    """项目 + 需求（带 dir_name）+ n 条 pending 用例，返回 (root, dir_name, rid)。"""
    root = tempfile.mkdtemp(prefix="cap-tr-")
    pid = R.ProjectRepo.create(conn, "demo", root)["id"]
    rid = R.RequirementRepo.create(conn, pid, "免密登录", "", dir_name="免密登录")["id"]
    for i in range(n):
        R.TestCaseRepo.create(conn, rid, f"用例{i + 1}")
    return root, "免密登录", rid


def _report(root, dir_name, content):
    d = os.path.join(root, ".janus", dir_name, "arch")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "test-result.md"), "w", encoding="utf-8") as f:
        f.write(content)


# ---------------- parse_report：表格解析 ----------------

def test_parse_standard_table():
    md = """# 测试报告

| 用例 | 标题 | 结果 | 说明 |
| --- | --- | --- | --- |
| 01 | 正确密码可登录 | 通过 | 64ms |
| 02 | 错误密码提示 | 失败 | 未弹提示 |
| 03 | 隐身窗口无入口 | 跳过 | 环境限制 |
| 04 | 锁定后提示 | 未执行 | 排期中 |
"""
    assert TR.parse_report(md) == {1: "passed", 2: "failed", 3: "skipped", 4: "pending"}


def test_parse_failure_keyword_wins_over_pass():
    # 「未通过」包含「通过」，判定顺序必须 failed 在前
    md = """| 用例 | 标题 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | a | 未通过 | x |
"""
    assert TR.parse_report(md) == {1: "failed"}


def test_parse_tolerates_common_wordings():
    md = """| 用例 | 标题 | 结果 | 说明 |
| --- | --- | --- | --- |
| 用例 01 | a | passed | |
| 2 | b | ✅ | |
| 3 | c | ❌ | |
| 4 | d | skipped | |
| 5 | e | pending | |
"""
    assert TR.parse_report(md) == {1: "passed", 2: "passed", 3: "failed", 4: "skipped", 5: "pending"}


def test_parse_seq_falls_back_to_row_order():
    md = """| 用例 | 标题 | 结果 |
| --- | --- | --- |
| a | 甲 | 通过 |
| b | 乙 | 失败 |
"""
    assert TR.parse_report(md) == {1: "passed", 2: "failed"}


def test_parse_ignores_non_table_and_other_tables():
    md = """# 报告

结论：全部通过，30/30。

## 改动文件（无结果列，不该被误读）

| 文件 | 变更 |
| --- | --- |
| login.html | 新增 |
"""
    assert TR.parse_report(md) == {}


def test_parse_empty_and_plain_text():
    assert TR.parse_report("") == {}
    assert TR.parse_report("纯文字报告，第 1 条通过，第 2 条失败。") == {}


# ---------------- sync_cases：回写 ----------------

def test_sync_updates_statuses_and_stats():
    conn = _db()
    root, dname, rid = _fixture_with_cases(conn)
    _report(root, dname, """| 用例 | 标题 | 结果 | 说明 |
| --- | --- | --- | --- |
| 01 | 用例1 | 通过 | ok |
| 02 | 用例2 | 失败 | no |
| 03 | 用例3 | 通过 | ok |
""")
    out = TR.sync_cases(conn, rid, root, dname)
    assert out["found"] is True and out["rows"] == 3 and out["updated"] == 3
    assert out["stats"]["passed"] == 2 and out["stats"]["failed"] == 1
    statuses = [c["status"] for c in R.TestCaseRepo.list_by_requirement(conn, rid)]
    assert statuses == ["passed", "failed", "passed"]


def test_sync_only_touches_reported_rows():
    conn = _db()
    root, dname, rid = _fixture_with_cases(conn)  # 3 条
    _report(root, dname, """| 用例 | 标题 | 结果 | 说明 |
| --- | --- | --- | --- |
| 01 | 用例1 | 通过 | |
""")
    out = TR.sync_cases(conn, rid, root, dname)
    # 报告只覆盖第 1 条：其余保持 pending，不做全量重置
    assert out["updated"] == 1
    statuses = [c["status"] for c in R.TestCaseRepo.list_by_requirement(conn, rid)]
    assert statuses == ["passed", "pending", "pending"]


def test_sync_idempotent_second_run_updates_nothing():
    conn = _db()
    root, dname, rid = _fixture_with_cases(conn)
    _report(root, dname, """| 用例 | 标题 | 结果 |
| --- | --- | --- |
| 1 | a | 通过 |
""")
    assert TR.sync_cases(conn, rid, root, dname)["updated"] == 1
    assert TR.sync_cases(conn, rid, root, dname)["updated"] == 0


def test_sync_missing_report_is_not_an_error():
    conn = _db()
    root, dname, rid = _fixture_with_cases(conn)
    out = TR.sync_cases(conn, rid, root, dname)
    assert (out["found"], out["updated"]) == (False, 0)
    assert out["stats"]["total"] == 3
    # 报告是纯文字、解析不出表格：found=True 但不回写
    _report(root, dname, "全测完了，都过了。")
    out = TR.sync_cases(conn, rid, root, dname)
    assert (out["found"], out["updated"]) == (True, 0)
