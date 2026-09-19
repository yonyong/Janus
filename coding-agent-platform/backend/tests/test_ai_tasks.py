"""AI 辅助任务：提示词构造与解析（纯函数）。

解析是从 LLM 自由文本里抠结构化数据的一环，最容易因措辞差异失效，
因此这里把真实模型可能返回的几种形态都固化成用例：围栏 json、裸数组、
dict 包裹、夹在解释文字中间、尾逗号、字段别名、list 形式的 steps。
"""
from backend import ai_tasks as AI


def _raises(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except AI.AiTaskError as e:
        return e
    raise AssertionError("应当抛出 AiTaskError")


# ---------------- 提示词 ----------------

def test_case_prompt_mentions_requirement_and_schema():
    p = AI.build_case_prompt("登录优化", "用户希望免密登录", 4)
    assert "登录优化" in p and "用户希望免密登录" in p
    assert "4 条" in p
    for field in ("title", "steps", "expected"):
        assert field in p


def test_case_prompt_clamps_count():
    assert "30 条" in AI.build_case_prompt("t", "d", 999)   # 上限
    assert "1 条" in AI.build_case_prompt("t", "d", 0)      # 下限


def test_polish_prompt_asks_for_markdown_only():
    p = AI.build_polish_prompt("t", "d")
    assert "Markdown" in p and "不要输出任何解释" in p


# ---------------- 用例解析 ----------------

FENCED = """好的，我按要求设计如下用例：

```json
[
  {"title": "未登录访问首页", "steps": "1. 清空登录态\\n2. 打开首页", "expected": "跳转到登录页"}
]
```

以上用例覆盖了主流程。"""


def test_parse_fenced_json_with_surrounding_prose():
    cases = AI.parse_cases(FENCED)
    assert len(cases) == 1
    assert cases[0]["title"] == "未登录访问首页"
    assert "登录态" in cases[0]["steps"]
    assert cases[0]["expected"] == "跳转到登录页"


def test_parse_bare_array_without_fence():
    cases = AI.parse_cases('[{"title":"A","expected":"ok"},{"title":"B"}]')
    assert [c["title"] for c in cases] == ["A", "B"]


def test_parse_dict_wrapped_cases_key():
    text = '{"cases":[{"title":"C","steps":["第一步","第二步"],"expected":"通过"}]}'
    cases = AI.parse_cases(text)
    assert len(cases) == 1
    assert cases[0]["title"] == "C"
    # list 形式的 steps 会带序号拼成多行
    assert cases[0]["steps"] == "1. 第一步\n2. 第二步"


def test_parse_single_case_object():
    cases = AI.parse_cases('{"用例名称":"单条用例","预期结果":"成功"}')
    assert cases == [{"title": "单条用例", "steps": "", "expected": "成功"}]


def test_parse_tolerates_trailing_comma_and_noise():
    text = "```json\n[{'title':'x'}]\n```".replace("'", '"')
    assert [c["title"] for c in AI.parse_cases(text)] == ["x"]
    # 尾逗号
    assert [c["title"] for c in AI.parse_cases('[{"title":"y",},]')] == ["y"]
    # 前后有解释文字、JSON 夹在中间
    assert [c["title"] for c in AI.parse_cases('我给出用例：\n[{"title":"z"}]\n请查收')] == ["z"]


def test_parse_uses_first_successful_candidate():
    text = "```text\nnot json\n```\n```json\n[{\"title\":\"真用例\"}]\n```"
    assert [c["title"] for c in AI.parse_cases(text)] == ["真用例"]


def test_parse_dedupes_and_caps():
    many = "[" + ",".join(f'{{"title":"用例{i}"}}' for i in range(50)) + "]"
    assert len(AI.parse_cases(many)) == AI.MAX_CASES
    dup = '[{"title":"同一条"},{"title":" 同一条 "},{"title":"另一条"}]'
    assert [c["title"] for c in AI.parse_cases(dup)] == ["同一条", "另一条"]


def test_parse_skips_items_without_title():
    cases = AI.parse_cases('[{"steps":"只有步骤"},{"title":"有效"}]')
    assert [c["title"] for c in cases] == ["有效"]


def test_parse_string_array():
    assert [c["title"] for c in AI.parse_cases('["用例一","用例二"]')] == ["用例一", "用例二"]


def test_parse_failure_raises_with_raw():
    err = _raises(AI.parse_cases, "抱歉，我无法根据该需求生成用例。")
    assert "解析" in err.message
    assert "抱歉" in err.raw


# ---------------- 润色解析 ----------------

def test_parse_polished_strips_fence_and_label():
    raw = "润色后的需求文档：\n```markdown\n# 背景\n\n用户希望免密登录。\n```"
    assert AI.parse_polished(raw) == "# 背景\n\n用户希望免密登录。"


def test_parse_polished_keeps_plain_text():
    assert AI.parse_polished("## 目标\n\n- 支持免密登录") == "## 目标\n\n- 支持免密登录"


def test_parse_polished_empty_fails():
    _raises(AI.parse_polished, "   ")
    _raises(AI.parse_polished, "润色后的需求文档：")
