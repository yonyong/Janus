"""AI 辅助任务：需求文档润色、按需求生成功能验证用例。

设计取向：
- **提示词与解析放在后端**，前端只调一次接口拿结构化结果。这样最容易出错的一环
  （从 LLM 自由文本里抠出 JSON）可以用纯函数单测覆盖，不必依赖浏览器或真实模型。
- 真正调用 agent 复用 `agent_test.probe_agent`（超时强制终止、错误归一、限流识别都在那里），
  只是把工作目录换成项目根目录，让 agent 能看到项目上下文。
- 生成结果**先落库再返回**；解析失败不写任何数据，并把 AI 原文回传给前端，便于人工兜底。
"""
import json
import re

from .agent_test import MAX_TIMEOUT, probe_agent

# 生成的用例条数上限：防止模型一口气吐上百条把库撑爆
MAX_CASES = 30
DEFAULT_CASE_COUNT = 6
# 真实 CLI 冷启动 + 长上下文较慢，给足 3 分钟；上限沿用 agent_test 的 300s
DEFAULT_TIMEOUT = 180.0
# 回传给前端的 AI 原文长度上限（仅用于排查，不必全文）
RAW_LIMIT = 4000


class AiTaskError(Exception):
    """AI 任务失败，message 直接面向用户。

    kind 区分两类失败，因为它们的处理方式完全不同：
    - agent：调用层面失败（命令不存在、未认证、超时、没有任何输出）→ 接口应报错；
    - parse：模型答了、但不是能用的结构 → 不算接口错误，把原文交回前端让人工兜底。
    """

    def __init__(self, message: str, raw: str = "", kind: str = "agent"):
        super().__init__(message)
        self.message = message
        self.raw = raw
        self.kind = kind


# ---------------- 提示词 ----------------

def build_polish_prompt(title: str, doc: str) -> str:
    return (
        "你是资深需求分析师。请把下面这份需求文档润色成结构清晰、可直接执行的中文 Markdown 需求说明。\n"
        "要求：\n"
        "1. 保留原意与全部关键信息，不要编造未经确认的功能；信息不全时用「待确认」标注，不要臆测。\n"
        "2. 用「背景 / 目标 / 功能点 / 验收要点」这类小标题组织内容，条目化表达，避免大段流水账。\n"
        "3. 只输出润色后的 Markdown 正文，不要输出任何解释、也不要再用代码块包裹。\n\n"
        f"需求标题：{title or '（未命名需求）'}\n"
        "需求文档：\n"
        f"{doc}\n"
    )


def build_design_prompt(title: str, doc: str, attachment_paths: list[str] | None = None) -> str:
    att_note = ""
    if attachment_paths:
        att_note = (
            "需求附件（都在当前项目目录内，可直接打开阅读）：\n"
            + "\n".join(f"- {p}" for p in attachment_paths) + "\n\n"
        )
    return (
        "你是资深架构师。请根据下面的原始需求文档，产出一份详细设计文档，供后续的编码 Agent"
        "照着实现（编码 Agent 只看这份设计文档和原始需求，不再与你对话确认）。\n"
        "要求：\n"
        "1. 用中文 Markdown 书写，只输出文档正文，不要输出任何解释或寒暄。\n"
        "2. 文档必须包含以下小节：背景与目标、现状分析（先浏览项目目录与相关代码，说明现状）、\n"
        "   总体方案、涉及文件清单（列出预计新增/修改的具体文件路径）、实现步骤、\n"
        "   测试与验证方式（说明如何编写和运行单测验证）。\n"
        "3. 实现方案要落到具体文件与函数级别，避免空泛描述；信息不全时用「待确认」标注，不要臆测。\n"
        "4. 若提供了需求附件，先阅读它们再设计，并在文档中引用关键结论。\n\n"
        f"需求标题：{title or '（未命名需求）'}\n"
        f"{att_note}"
        "原始需求文档：\n"
        f"{doc}\n"
    )


def build_case_prompt(title: str, doc: str, count: int = DEFAULT_CASE_COUNT) -> str:
    try:
        n = int(count) if count is not None else DEFAULT_CASE_COUNT
    except (TypeError, ValueError):
        n = DEFAULT_CASE_COUNT
    n = max(1, min(n, MAX_CASES))
    return (
        "你是测试工程师。请根据下面的需求文档设计功能验证用例。\n"
        "要求：\n"
        f"1. 覆盖主流程、边界与异常路径，共 {n} 条左右；每条只验证一个点，标题简洁明确。\n"
        "2. 先输出一个 ```json 代码块，内容为对象数组，字段固定为：\n"
        "   title：用例标题（字符串）；\n"
        "   steps：操作步骤（字符串，多步用换行分隔）；\n"
        "   expected：预期结果（字符串）。\n"
        "3. 除该 JSON 代码块外不要输出任何内容（不要寒暄、不要解释、不要写测试代码）。\n\n"
        f"需求标题：{title or '（未命名需求）'}\n"
        "需求文档：\n"
        f"{doc}\n"
    )


# ---------------- 解析（纯函数，可单测） ----------------

_FENCE = re.compile(r"```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n(.*?)```", re.S)
_TRAILING_COMMA = re.compile(r",(\s*[}\]])")
_CASE_LIST_KEYS = ("cases", "test_cases", "testcases", "testCases", "用例", "items", "data", "list", "results")
_TITLE_KEYS = ("title", "name", "case", "summary", "scenario", "标题", "用例", "用例名称", "名称")
_STEPS_KEYS = ("steps", "step", "actions", "action", "given", "操作步骤", "步骤", "前置条件")
_EXPECTED_KEYS = ("expected", "expected_result", "expect", "then", "assert", "预期", "预期结果", "期望结果")


def _strip_fences(text: str) -> str:
    """把整体被 ``` 包住的文本剥掉围栏（保留内部内容原样）。"""
    t = (text or "").strip()
    m = _FENCE.search(t)
    if m and m.group(2).strip() and m.group(0).strip() == t.strip():
        return m.group(2).strip()
    return t


def _json_candidates(text: str):
    """按优先级产出可尝试解析的候选片段：json 围栏 → 其他围栏 → 全文 → 括号平衡片段。"""
    t = text or ""
    seen = set()

    def push(s: str):
        s = (s or "").strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)

    out: list[str] = []
    fences = _FENCE.findall(t)
    for lang, body in fences:
        if lang.lower() in ("json", "jsonc", ""):
            push(body)
    for _lang, body in fences:
        push(body)
    push(t)
    for chunk in _balanced_chunks(t):
        push(chunk)
    return out


def _balanced_chunks(text: str, limit: int = 8):
    """粗粒度扫描出顶层平衡的 [] / {} 片段（跳过字符串内的括号与转义）。"""
    chunks = []
    for opener, closer in (("[", "]"), ("{", "}")):
        depth = 0
        start = -1
        in_str = False
        escape = False
        for i, ch in enumerate(text):
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == opener:
                if depth == 0:
                    start = i
                depth += 1
            elif ch == closer and depth:
                depth -= 1
                if depth == 0 and start >= 0:
                    chunks.append(text[start:i + 1])
                    if len(chunks) >= limit:
                        return chunks
                    start = -1
    return chunks


def _loads_lenient(chunk: str):
    """容错解析：先直解，失败再去尾逗号、去 BOM / 零宽字符后直解。"""
    cleaned = _TRAILING_COMMA.sub(r"\1", chunk).replace("\ufeff", "").replace("\u200b", "")
    for candidate in (chunk, cleaned):
        try:
            return json.loads(candidate)
        except Exception:  # noqa: BLE001
            continue
    return None


def _first_key(item: dict, keys) -> str:
    for k in keys:
        if k in item and item[k] is not None:
            return k
    # 大小写/空格不敏感兜底
    lowered = {str(k).strip().lower(): k for k in item.keys()}
    for k in keys:
        hit = lowered.get(k.strip().lower())
        if hit is not None and item[hit] is not None:
            return hit
    return ""


def _as_text(val) -> str:
    if val is None:
        return ""
    if isinstance(val, str):
        return val.strip()
    if isinstance(val, (int, float, bool)):
        return str(val)
    if isinstance(val, dict):
        return "\n".join(f"{k}：{_as_text(v)}" for k, v in val.items() if _as_text(v))
    if isinstance(val, (list, tuple)):
        parts = []
        for i, v in enumerate(val, 1):
            s = _as_text(v)
            if s:
                parts.append(f"{i}. {s}" if isinstance(v, (str, int, float)) else s)
        return "\n".join(parts)
    return str(val).strip()


def _normalize_items(data, limit: int = MAX_CASES) -> list[dict]:
    """把任意解析结果整理成 [{title, steps, expected}]。"""
    items = None
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        for key in _CASE_LIST_KEYS:
            v = data.get(key)
            if isinstance(v, list):
                items = v
                break
        if items is None and _first_key(data, _TITLE_KEYS):
            items = [data]  # 模型把「一条用例」直接返回成对象
        if items is None:
            # 值为 dict 的字段（如 {"用例1": {...}}）也认
            nested = [v for v in data.values() if isinstance(v, dict)]
            items = nested or None
    if not items:
        return []

    out = []
    seen = set()
    for it in items:
        if isinstance(it, str):
            title, steps, expected = it.strip(), "", ""
        elif isinstance(it, dict):
            title = _as_text(it.get(_first_key(it, _TITLE_KEYS)))
            steps = _as_text(it.get(_first_key(it, _STEPS_KEYS)))
            expected = _as_text(it.get(_first_key(it, _EXPECTED_KEYS)))
        else:
            continue
        title = re.sub(r"\s+", " ", title).strip(" -·:：")
        if not title or title in seen:
            continue
        seen.add(title)
        out.append({"title": title[:200], "steps": steps[:4000], "expected": expected[:2000]})
        if len(out) >= limit:
            break
    return out


def parse_cases(text: str, limit: int = MAX_CASES) -> list[dict]:
    """从 LLM 自由文本里抽出用例数组。抽不出时抛 AiTaskError（附带原文）。"""
    for chunk in _json_candidates(text):
        data = _loads_lenient(chunk)
        if data is None:
            continue
        cases = _normalize_items(data, limit)
        if cases:
            return cases
    raise AiTaskError(
        "未能从 AI 回复中解析出用例（要求模型输出 ```json 数组）。可以重试，或手动新增用例。",
        raw=(text or "")[:RAW_LIMIT],
        kind="parse",
    )


# 模型常加的前缀标签，剥掉后才是正文
_POLISH_LABELS = re.compile(r"^(润色后的需求文档|润色结果|以下是润色后的(需求)?文档|需求文档)[:：]?\s*", re.I)


def parse_polished(text: str) -> str:
    """取出润色后的正文：剥掉「润色后的需求文档：」这类前缀与整体围栏。"""
    body = _POLISH_LABELS.sub("", (text or "").strip()).strip()
    # 整体被围栏包住（允许围栏前还有一行标签）
    if body.startswith("```"):
        lines = body.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        body = "\n".join(lines).strip()
    body = _POLISH_LABELS.sub("", body).strip()
    body = _strip_fences(body).strip()
    body = _POLISH_LABELS.sub("", body).strip()
    if not body:
        raise AiTaskError("AI 未返回可用的润色内容，请重试。", raw=(text or "")[:RAW_LIMIT],
                          kind="parse")
    return body[:60000]


# ---------------- 调用 agent ----------------

def _join_reply(events: list) -> str:
    """把 message 事件的文本拼起来（真实 CLI 可能分段输出，只看第一条会截断）。"""
    parts = [(e.get("text") or "").strip() for e in events
             if (e.get("type") == "message" and (e.get("text") or "").strip())]
    if parts:
        return "\n".join(parts)
    for e in events:
        t = (e.get("text") or "").strip()
        if t:
            return t
    return ""


async def run_agent_task(agent_row: dict, prompt: str, project_path: str,
                         timeout: float | None = None, source: str = "ai_cases",
                         context: dict | None = None) -> dict:
    """调用一次 agent 并返回其文本回复（不落库、不改会话）。

    返回 {reply, error, timed_out, rate_limited, elapsed_ms, events}；error 非空表示调用失败。
    source / context 只用于 Agent 调用留痕：区分「生成用例 / 润色」并带上归属信息。
    """
    t = float(timeout) if timeout else DEFAULT_TIMEOUT
    t = max(5.0, min(t, MAX_TIMEOUT))
    result = await probe_agent(agent_row, prompt, t, workdir=project_path,
                               source=source, context=context)
    return {
        "reply": _join_reply(result.get("events") or []),
        "error": result.get("error"),
        "timed_out": bool(result.get("timed_out")),
        "rate_limited": bool(result.get("rate_limited")),
        "elapsed_ms": result.get("elapsed_ms") or 0,
        "agent_name": result.get("agent_name"),
    }


async def generate_cases(agent_row: dict, title: str, doc: str, project_path: str,
                         count: int = DEFAULT_CASE_COUNT, timeout: float | None = None,
                         context: dict | None = None) -> dict:
    """按需求生成用例；调用或解析失败时抛 AiTaskError（不写库）。"""
    prompt = build_case_prompt(title, doc, count)
    run = await run_agent_task(agent_row, prompt, project_path, timeout,
                               source="ai_cases", context=context)
    if run["error"]:
        raise AiTaskError(f"调用 agent 失败：{run['error']}", raw=run["reply"][:RAW_LIMIT])
    if not run["reply"].strip():
        raise AiTaskError("agent 未返回任何内容，请检查该 agent 是否可用（可先到 Agent 管理页做一键测试）。")
    cases = parse_cases(run["reply"])
    return {"cases": cases, "raw": run["reply"][:RAW_LIMIT], "elapsed_ms": run["elapsed_ms"],
            "agent_name": run["agent_name"]}


async def polish_document(agent_row: dict, title: str, doc: str, project_path: str,
                          timeout: float | None = None, context: dict | None = None) -> dict:
    """润色需求文档；失败时抛 AiTaskError（不改库）。"""
    prompt = build_polish_prompt(title, doc)
    run = await run_agent_task(agent_row, prompt, project_path, timeout,
                               source="ai_polish", context=context)
    if run["error"]:
        raise AiTaskError(f"调用 agent 失败：{run['error']}", raw=run["reply"][:RAW_LIMIT])
    content = parse_polished(run["reply"])
    return {"content": content, "raw": run["reply"][:RAW_LIMIT], "elapsed_ms": run["elapsed_ms"],
            "agent_name": run["agent_name"]}


async def generate_design(agent_row: dict, title: str, doc: str, project_path: str,
                          attachment_paths: list[str] | None = None,
                          timeout: float | None = None,
                          context: dict | None = None) -> dict:
    """依据原始需求生成详细设计文档；失败时抛 AiTaskError（不改库）。

    agent 在项目根目录运行：提示词里给了需求附件的项目内路径，它自己能读。
    """
    prompt = build_design_prompt(title, doc, attachment_paths)
    run = await run_agent_task(agent_row, prompt, project_path, timeout,
                               source="ai_design", context=context)
    if run["error"]:
        raise AiTaskError(f"调用 agent 失败：{run['error']}", raw=run["reply"][:RAW_LIMIT])
    if not run["reply"].strip():
        raise AiTaskError("agent 未返回任何内容，请检查该 agent 是否可用（可先到 Agent 管理页做一键测试）。")
    content = parse_polished(run["reply"])
    return {"content": content, "raw": run["reply"][:RAW_LIMIT], "elapsed_ms": run["elapsed_ms"],
            "agent_name": run["agent_name"]}
