"""测试报告解析与用例状态回写。

归档验收页的「测试报告 X/N 条通过」读的是数据库 test_case.status，而编码 Agent
只负责把报告写到工作区 `.janus/{dir}/arch/test-result.md`——两边此前没有同步链路，
Agent 说 30/30 全过，页面仍显示 0/30。本模块补上这一段：解析报告里的 **Markdown
表格**（表头约定：用例序号 | 标题 | 结果 | 说明），按库内用例顺序把每条的执行
结果回写到 test_case.status。

表格约定（与前端快捷指令、docs.py 的路径约定保持同一套措辞）：

    | 用例 | 标题 | 结果 | 说明 |
    | --- | --- | --- | --- |
    | 01 | 正确密码可登录 | 通过 | 64ms |
    | 02 | 错误密码提示 | 失败 | 未弹提示 |

- 「结果」列取值：通过 / 失败 / 跳过 / 未执行（也容忍 passed/failed/skipped/pending、
  ✅/❌ 等常见写法）；
- 「用例」列取行内数字当序号（"01"、"用例 01"、"1" 都行），没有数字就按出现顺序
  递增；
- 解析不出结果列的行直接忽略——报告里混入的说明文字、别的表格都不影响回写。

解析是宽容的（Agent 写法千差万别），回写是克制的：只更新报告里明确给出结果的
条目，没出现的用例保持原状态，不做全量重置。
"""
import os
import sqlite3

from . import repositories as R
from . import docs as WD
from . import files as FS

# 结果关键词 → 用例状态。匹配顺序就是列表顺序：「未通过」必须先于「通过」判定，
# 否则会被误判成 passed。
_STATUS_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("failed", ("失败", "未通过", "failed", "fail", "❌", "✗", "✘")),
    ("skipped", ("跳过", "skipped", "skip", "忽略")),
    ("passed", ("通过", "passed", "pass", "成功", "✅", "✔")),
    ("pending", ("未执行", "未验证", "待验证", "未测", "pending")),
]

# 表头里能认出「结果」列的关键词
_RESULT_HEADER = ("结果", "结论", "status", "状态")
# 表头里能认出「用例序号」列的关键词；都认不出时默认第一列就是序号
_SEQ_HEADER = ("用例", "序号", "编号", "no", "#")
# 表头里能认出「标题」列的关键词（覆盖度判定用）
_TITLE_HEADER = ("标题", "用例名", "名称", "title", "name")


def _match_status(cell: str) -> str | None:
    """把结果单元格的文本翻译成用例状态；认不出返回 None。"""
    low = (cell or "").strip().lower()
    if not low:
        return None
    for status, words in _STATUS_KEYWORDS:
        if any(w in low for w in words):
            return status
    return None


def _seq_of(cell: str, fallback: int) -> int:
    """从序号单元格提取数字（"01" / "用例 01" / "1."）；提取不出按行序递增。"""
    digits = "".join(ch for ch in (cell or "") if ch.isdigit())
    return int(digits) if digits else fallback


def _split_row(line: str) -> list[str]:
    """把 `| a | b | c |` 拆成 [a, b, c]；容忍首尾竖线缺失。"""
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _is_separator(cells: list[str]) -> bool:
    """表头下的 `| --- | :---: |` 分隔行。"""
    return bool(cells) and all(c and set(c) <= set("-: ") for c in cells)


def _table_rows(content: str) -> list[list[str]]:
    """收集所有 Markdown 表格行（已拆格、已去掉 `---` 分隔行）。"""
    rows = []
    for line in (content or "").splitlines():
        if "|" not in line or not line.strip().startswith("|"):
            continue
        cells = _split_row(line)
        if _is_separator(cells):
            continue
        rows.append(cells)
    return rows


def parse_report(content: str) -> dict[int, str]:
    """解析测试报告 Markdown，返回 {用例序号(1 起): 状态}。

    两段式解析：
    1. 标准模式——找「表头行 + --- 分隔行」的表格，按表头定位结果列与序号列；
    2. 宽松兜底——没有规整表头时，逐行在单元格里找结果关键词，第一列当序号。
    一条都解析不出来就返回空表（调用方按「报告里没有可回写的结果」处理，
    而不是报错——报告可能是纯文字版）。
    """
    rows = _table_rows(content)

    # 标准模式：表头行 = 后面跟分隔行、且能认出结果列的那一行
    header_i = -1
    for i, cells in enumerate(rows):
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        if nxt is None or not _is_separator(nxt):
            continue
        low = [c.lower() for c in cells]
        if any(any(w in c for w in _RESULT_HEADER) for c in low):
            header_i = i
            break
    if header_i >= 0:
        header = [c.lower() for c in rows[header_i]]
        result_col = next(i for i, c in enumerate(header)
                          if any(w in c for w in _RESULT_HEADER))
        seq_col = next((i for i, c in enumerate(header)
                        if any(w in c for w in _SEQ_HEADER)), 0)
        result: dict[int, str] = {}
        row_no = 0
        for cells in rows[header_i + 2:]:
            if len(cells) <= max(seq_col, result_col):
                continue
            status = _match_status(cells[result_col])
            if status is None:
                continue
            row_no += 1
            result[_seq_of(cells[seq_col], row_no)] = status
        if result:
            return result

    # 宽松兜底：逐行找第一个含结果词的单元格，第一列当序号，行序递增补位
    result = {}
    row_no = 0
    for cells in rows:
        if not cells:
            continue
        status = next((s for c in cells if (s := _match_status(c))), None)
        if status is None:
            continue
        row_no += 1
        result[_seq_of(cells[0], row_no)] = status
    return result


def report_titles(content: str) -> set[str]:
    """从报告表格「标题」列取出出现过的用例标题集合（用于覆盖度判定）。

    仅在能识别出规整表头（含结果列 + 标题列 + `---` 分隔行）时返回标题；否则返回
    空集（覆盖度未知，调用方不据此判「未覆盖」，避免误伤）。这里按原始行扫描（保留
    分隔行），因为表头识别依赖它后面紧跟的 `---` 分隔行。
    """
    lines = [ln for ln in (content or "").splitlines()
             if "|" in ln and ln.strip().startswith("|")]
    for i, ln in enumerate(lines):
        cells = _split_row(ln)
        nxt = _split_row(lines[i + 1]) if i + 1 < len(lines) else None
        if nxt is None or not _is_separator(nxt):
            continue
        low = [c.lower() for c in cells]
        if not any(any(w in c for w in _RESULT_HEADER) for c in low):
            continue
        title_col = next((j for j, c in enumerate(low)
                          if any(w in c for w in _TITLE_HEADER)), None)
        if title_col is None:
            return set()
        titles: set[str] = set()
        for dl in lines[i + 2:]:
            r = _split_row(dl)
            if _is_separator(r):
                continue
            if len(r) > title_col and r[title_col].strip():
                titles.add(r[title_col].strip())
        return titles
    return set()


def read_report(root: str, dir_name: str) -> str | None:
    """读工作区测试报告；不存在或路径非法返回 None。"""
    if not (dir_name or "").strip():
        return None
    try:
        ap = FS.abs_path(FS.ensure_root(root), WD.test_result_doc(dir_name))
    except FS.FsError:
        return None
    if not os.path.isfile(ap):
        return None
    with open(ap, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def sync_cases(conn: sqlite3.Connection, rid: int, root: str, dir_name: str) -> dict:
    """解析报告并回写用例状态；报告缺失时返回 found=False，其余字段照常给全。

    只动报告里明确给出结果的条目；返回回写条数与最新统计，供前端提示与看板刷新。
    """
    content = read_report(root, dir_name)
    stats = R.TestCaseRepo.stats(conn, rid)
    if content is None:
        return {"found": False, "rows": 0, "updated": 0, "updated_ids": [], "stats": stats}
    mapping = parse_report(content)
    updated_ids: list[int] = []
    for i, case in enumerate(R.TestCaseRepo.list_by_requirement(conn, rid), 1):
        status = mapping.get(i)
        if status and status != case["status"]:
            R.TestCaseRepo.update(conn, case["id"], status=status)
            updated_ids.append(case["id"])
    return {
        "found": True,
        "rows": len(mapping),
        "updated": len(updated_ids),
        "updated_ids": updated_ids,
        "stats": R.TestCaseRepo.stats(conn, rid),
    }
