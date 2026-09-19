"""日志总线单测：环形缓冲、增量读取、过滤、归属上下文与「写入永不抛异常」。

logbus 是模块级进程内状态，跨测试共享，所以每个用例开头都 reset()，
否则前一个用例留下的记录会把 seq / 过滤断言搅乱。
"""
from backend import logbus as L


def _fresh():
    L.reset()


# ---------------- 写入与归一 ----------------

def test_emit_returns_record_with_incrementing_seq():
    _fresh()
    a = L.emit(3, "第一条", source="agent")
    b = L.emit(3, "第二条", level="warn", source="files")
    assert a["seq"] == 1 and b["seq"] == 2
    assert a["project_id"] == 3 and a["level"] == "info" and a["source"] == "agent"
    assert b["level"] == "warn"
    # 时间戳形如 2026-09-19 02:00:00.123，界面直接切显示
    assert len(a["ts"]) == 23 and a["ts"][10] == " " and a["ts"][19] == "."


def test_normalize_level_maps_aliases_and_unknown():
    assert L.normalize_level("WARNING") == "warn"
    assert L.normalize_level("err") == "error"
    assert L.normalize_level("fatal") == "error"
    assert L.normalize_level("trace") == "debug"
    assert L.normalize_level(None) == "info"
    assert L.normalize_level("随便什么") == "info"


def test_normalize_source_keeps_unknown_but_defaults_empty():
    assert L.normalize_source(" Agent ") == "agent"
    assert L.normalize_source("") == "system"
    assert L.normalize_source(None) == "system"
    # 未知来源原样保留，避免写错一个词就静默丢掉一整类日志
    assert L.normalize_source("custom") == "custom"


def test_emit_never_raises_on_bad_input():
    _fresh()
    # project_id 不是数字 -> 归到平台级而不是抛异常
    assert L.emit("not-a-number", "x")["project_id"] is None
    assert L.emit(None, None)["text"] == ""
    assert L.emit(1, "x", level=object())["level"] == "info"
    # meta 原样保留
    assert L.emit(1, "x", meta={"k": "v"})["meta"] == {"k": "v"}


def test_emit_lines_splits_and_marks_omission():
    _fresh()
    n = L.emit_lines(2, "第一行\n\n  第二行  \r\n第三行", source="agent")
    assert n == 3
    got = L.snapshot(2)["records"]
    assert [r["text"] for r in got] == ["第一行", "  第二行", "第三行"]
    assert all(r["source"] == "agent" for r in got)

    _fresh()
    n = L.emit_lines(2, "\n".join(f"L{i}" for i in range(L.MAX_LINES_PER_EMIT + 5)))
    assert n == L.MAX_LINES_PER_EMIT + 1  # 多出的一条是省略说明
    assert "5 行未记录" in L.snapshot(2)["records"][-1]["text"]


def test_split_lines_and_clip_edge_cases():
    assert L.split_lines(None) == []
    assert L.split_lines("a\r\nb\rc") == ["a", "b", "c"]
    assert L.clip_text("x" * 5, limit=10) == "xxxxx"
    clipped = L.clip_text("h" * 100 + "t" * 100, limit=40)
    # 头尾都保留：只看头部会把 agent 输出最该看的结论丢掉
    assert clipped.startswith("h") and clipped.endswith("t")
    assert "省略" in clipped and len(clipped) < 200


# ---------------- 增量读取与过滤 ----------------

def test_snapshot_incremental_by_seq():
    _fresh()
    L.emit(1, "a")
    L.emit(1, "b")
    first = L.snapshot(1, after_seq=0)
    assert first["last_seq"] == 2 and len(first["records"]) == 2
    L.emit(1, "c")
    more = L.snapshot(1, after_seq=first["last_seq"])
    assert [r["text"] for r in more["records"]] == ["c"]
    assert more["last_seq"] == 3
    # after_seq 非法值按 0 处理，不抛异常
    assert len(L.snapshot(1, after_seq="xx")["records"]) == 3


def test_snapshot_filters_levels_sources_and_project():
    _fresh()
    L.emit(1, "a-info", level="info", source="agent")
    L.emit(1, "a-error", level="error", source="agent")
    L.emit(2, "b-info", level="info", source="audit")
    L.emit(None, "platform", level="info", source="probe")

    assert len(L.snapshot(1)["records"]) == 2
    assert [r["text"] for r in L.snapshot(1, levels=["error"])["records"]] == ["a-error"]
    assert [r["text"] for r in L.snapshot(1, sources=["audit"])["records"]] == []
    assert [r["text"] for r in L.snapshot(None)["records"]] == ["a-info", "a-error", "b-info", "platform"]


def test_snapshot_include_global_brings_platform_records():
    _fresh()
    L.emit(1, "项目内")
    L.emit(None, "平台级")
    L.emit(2, "别的项目")
    only = L.snapshot(1)
    assert [r["text"] for r in only["records"]] == ["项目内"]
    with_global = L.snapshot(1, include_global=True)
    assert [r["text"] for r in with_global["records"]] == ["项目内", "平台级"]


def test_snapshot_truncated_keeps_newest():
    _fresh()
    for i in range(10):
        L.emit(1, f"n{i}")
    page = L.snapshot(1, limit=3)
    assert page["truncated"] is True
    assert [r["text"] for r in page["records"]] == ["n7", "n8", "n9"]
    assert page["last_seq"] == 10
    assert L.snapshot(1, limit=99)["truncated"] is False


def test_ring_buffer_evicts_and_reports_dropped():
    _fresh()
    total = L.MAX_RECORDS + 25
    for i in range(total):
        L.emit(1, f"n{i}")
    page = L.snapshot(1, after_seq=0, limit=L.MAX_RECORDS)
    assert page["buffered"] == L.MAX_RECORDS
    assert page["capacity"] == L.MAX_RECORDS
    assert len(page["records"]) == L.MAX_RECORDS
    # 最老的 25 条已被滚出，客户端从 0 起读会被告知「中间有记录丢失」
    assert page["dropped"] is True
    assert page["records"][0]["text"] == "n25"
    # 已经追平缓冲最老一条之后就不再报丢
    assert L.snapshot(1, after_seq=page["last_seq"] - 1)["dropped"] is False


def test_stats_and_reset():
    _fresh()
    assert L.stats()["buffered"] == 0 and L.stats()["oldest_seq"] == 0
    L.emit(1, "a")
    L.emit(2, "b")
    st = L.stats()
    assert st == {"buffered": 2, "capacity": L.MAX_RECORDS, "oldest_seq": 1, "newest_seq": 2}
    L.reset()
    assert L.stats()["buffered"] == 0
    assert L.emit(1, "again")["seq"] == 1


# ---------------- 归属上下文（适配器靠它把子进程输出归到项目） ----------------

def test_bind_provides_project_for_emit_current():
    _fresh()
    assert L.emit_current("无归属")["project_id"] is None
    with L.bind(project_id=7, session_id=11, requirement_id=22):
        assert L.scope() == {"project_id": 7, "session_id": 11, "requirement_id": 22}
        rec = L.emit_current("带归属", source="agent")
        assert rec["project_id"] == 7
        assert rec["meta"] == {"session_id": 11, "requirement_id": 22}
        n = L.emit_lines_current("行一\n行二", source="probe")
        assert n == 2
    # 退出后上下文还原，不会污染后续写入
    assert L.scope() == {}
    assert L.emit_current("出块后")["project_id"] is None
    texts = [r["text"] for r in L.snapshot(7)["records"]]
    assert texts == ["带归属", "行一", "行二"]
