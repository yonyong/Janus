"""Agent 连通性探测（Agent 管理页「一键测试」）。

以一条探针消息（默认「你好」）真实调用该 agent 的 provider，判断配置是否可用。
与工作台会话解耦：不建会话、不落 messages、不改动真实项目（工作目录为一次性临时目录）。

**它也是 Agent 调用留痕的唯一收口**：工作台会话、一键测试、AI 任务（生成用例 / 润色）
三个入口都会走到这里，因此每次调用都在 `probe_agent` 末尾写一条 agent_invocations 记录 ——
成功与失败都写。留痕失败不影响探测结果（见 audit.arecord_invocation）。
"""
import asyncio
import json
import os
import shutil
import tempfile
import time

from . import audit
from . import logbus as LOG
from .agent_runtime import AgentRegistry

DEFAULT_PROBE_MESSAGE = "你好"
DEFAULT_TIMEOUT = 30.0
MAX_TIMEOUT = 300.0
MAX_EVENTS = 100


async def _rmtree_with_retry(path: str, attempts: int = 5, delay: float = 0.4) -> None:
    """删除探针临时工作目录，失败则短暂重试。

    Windows 上被强杀的 CLI 需要一点时间才释放目录句柄，单次 ``rmtree(ignore_errors=True)``
    会静默失败，导致 ``cap-agent-probe-*`` 目录越堆越多。
    """
    for _ in range(attempts):
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            return
        await asyncio.sleep(delay)


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _normalize_timeout(timeout) -> float:
    try:
        t = float(timeout)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    if t <= 0:
        return DEFAULT_TIMEOUT
    return min(t, MAX_TIMEOUT)


def _event_to_dict(ev) -> dict:
    """adapter 可能产出 AgentEvent 或裸 dict，统一成可 JSON 序列化的字典。"""
    if isinstance(ev, dict):
        return {
            "type": ev.get("type") or "message",
            "pane": ev.get("pane") or "message",
            "text": ev.get("text"),
            "payload": ev.get("payload"),
        }
    to_json = getattr(ev, "to_json", None)
    if callable(to_json):
        return json.loads(to_json())
    return {
        "type": getattr(ev, "type", "message"),
        "pane": getattr(ev, "pane", "message"),
        "text": getattr(ev, "text", None),
        "payload": getattr(ev, "payload", None),
    }


def _pick_reply(events: list) -> str | None:
    """优先取 message 事件的文本，其次任意带文本的事件。"""
    for e in events:
        if e.get("type") == "message" and (e.get("text") or "").strip():
            return e["text"].strip()
    for e in events:
        t = (e.get("text") or "").strip()
        if t:
            return t
    return None


def _usage_of(events: list) -> dict | None:
    """取事件 payload 里适配器带回的真实 token 用量（CLI --output-format json 解析所得）。"""
    for e in events:
        u = (e.get("payload") or {}).get("usage")
        if isinstance(u, dict) and u:
            return u
    return None


def _log_event(ev: dict) -> None:
    """把探测过程中收到的单个事件写进实时日志（归属由 logbus 上下文提供）。"""
    text = (ev.get("text") or "").strip()
    if not text:
        return
    if ev.get("type") == "error":
        LOG.emit_current(f"探测报错：{text[:600]}", level="error", source="probe")
    else:
        LOG.emit_lines_current(text, level="info", source="probe")


async def _collect(provider, agent_row, message: str, workdir: str, sink: list) -> None:
    try:
        async for ev in provider.invoke(agent_row, message, workdir):
            d = _event_to_dict(ev)
            if d.get("type") == "delta" or (d.get("payload") or {}).get("transient"):
                # 流式增量 / 瞬态过程事件只对实时会话有意义：探测只关心最终结果，
                # 不收进事件表（否则一次长回答的上百条 delta 会把 MAX_EVENTS 挤爆，
                # 最终 message 事件反而进不来）。调用工具的提示转成一行调试日志留痕。
                if d.get("type") == "status":
                    LOG.emit_current(f"探测过程：{d.get('text') or ''}",
                                     level="debug", source="probe")
                continue
            sink.append(d)
            _log_event(d)
            if len(sink) >= MAX_EVENTS:
                break
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        sink.append({"type": "error", "pane": "message", "text": f"agent 执行异常: {e}", "payload": None})
        LOG.emit_current(f"探测报错：agent 执行异常 {e}", level="error", source="probe")


async def probe_agent(agent_row: dict, message: str = DEFAULT_PROBE_MESSAGE,
                      timeout=DEFAULT_TIMEOUT, workdir: str | None = None,
                      source: str = "probe", context: dict | None = None) -> dict:
    """探测单个 agent 是否可用，返回结构化结果（不抛异常，失败信息落在 error 字段）。

    ``source`` 与 ``context`` 只影响留痕：source 区分 session / probe / ai_cases / ai_polish，
    context 可带 project_id/project_name/requirement_id/requirement_title/session_id/actor。
    context 里的 project_id 同时决定实时日志的归属：从 Agent 管理页发起的一键测试没有
    项目上下文，日志落在平台级（项目页可勾选「包含平台日志」看到）。
    """
    ctx = context or {}
    with LOG.bind(project_id=ctx.get("project_id"), session_id=ctx.get("session_id"),
                  requirement_id=ctx.get("requirement_id")):
        result = await _probe_once(agent_row, message, timeout, workdir)
    await _record_invocation(agent_row, result, source, ctx)
    return result


def _all_text(events: list) -> str:
    """把事件里的文本拼成完整输出（留痕要的是模型到底说了什么，不是第一段）。"""
    parts = [(e.get("text") or "").strip() for e in events if (e.get("text") or "").strip()]
    return "\n".join(parts)


async def _record_invocation(agent_row, result: dict, source: str, ctx: dict) -> None:
    """写一条调用留痕。无论成功、失败、超时还是未注册类型，都会走到这里。"""
    detail = _all_text(result.get("events") or [])
    if not detail:
        detail = result.get("reply") or ""
    await audit.arecord_invocation(
        source=source,
        agent=agent_row,
        prompt=result.get("message") or "",
        response=detail,
        error=result.get("error") or "",
        elapsed_ms=result.get("elapsed_ms") or 0,
        event_count=len(result.get("events") or []),
        timed_out=bool(result.get("timed_out")),
        rate_limited=bool(result.get("rate_limited")),
        project={"id": ctx.get("project_id"), "name": ctx.get("project_name")},
        requirement={"id": ctx.get("requirement_id"), "title": ctx.get("requirement_title")},
        session_id=ctx.get("session_id"),
        actor=ctx.get("actor"),
        usage=result.get("usage"),
    )


async def _probe_once(agent_row: dict, message: str, timeout,
                      workdir: str | None) -> dict:
    started = time.perf_counter()
    agent = agent_row or {}
    agent_type = agent.get("type", "")
    result = {
        "ok": False,
        "agent_id": agent.get("id"),
        "agent_name": agent.get("name"),
        "type": agent_type,
        "message": message or DEFAULT_PROBE_MESSAGE,
        "reply": None,
        "error": None,
        "timed_out": False,
        "rate_limited": False,
        "elapsed_ms": 0,
        "events": [],
        "workdir": None,
    }

    try:
        provider = AgentRegistry.get(agent_type)
    except KeyError:
        known = ", ".join(AgentRegistry.registered()) or "无"
        result["error"] = f"未注册的 agent 类型: {agent_type}（已注册：{known}）"
        result["elapsed_ms"] = _ms(started)
        LOG.emit_current(f"一键测试失败：{result['error']}", level="error", source="probe",
                         meta={"agent": agent.get("name")})
        return result

    timeout = _normalize_timeout(timeout)
    owns_dir = workdir is None
    if workdir is None:
        workdir = tempfile.mkdtemp(prefix="cap-agent-probe-")
    result["workdir"] = workdir
    LOG.emit_current(f"一键测试开始：Agent「{agent.get('name')}」({agent_type})，"
                     f"探针消息「{result['message']}」，超时 {timeout:g}s，"
                     f"工作目录 {workdir if owns_dir else '(调用方指定)'}",
                     level="info", source="probe", meta={"agent": agent.get("name")})

    events: list = []
    try:
        task = asyncio.create_task(_collect(provider, agent, result["message"], workdir, events))
        try:
            await asyncio.wait_for(task, timeout=timeout)
        except asyncio.TimeoutError:
            result["timed_out"] = True
            result["error"] = f"调用超时：{timeout:g}s 内未返回，已强制终止本次探测"
        except Exception as e:  # noqa: BLE001
            result["error"] = f"agent 执行异常: {e}"
    finally:
        if owns_dir:
            await _rmtree_with_retry(workdir)

    result["events"] = events
    result["reply"] = _pick_reply(events)
    # 真实 token 用量：适配器从 CLI JSON 结果里解析出来放在 message 事件的 payload 上
    result["usage"] = _usage_of(events)
    if result["error"] is None:
        errs = [e for e in events if e.get("type") == "error"]
        if errs:
            result["error"] = (errs[0].get("text") or "").strip() or "agent 返回了 error 事件"
        elif not events:
            result["error"] = "agent 未返回任何事件（请检查命令与参数是否能正常输出）"
    result["ok"] = result["error"] is None and bool(events)
    result["elapsed_ms"] = _ms(started)

    # 限流识别：若错误/事件文本含频率限制特征，标记为模型侧限流（连接本身可达，
    # 非配置错误）。注意 codebuddy 在硬限流时可能静默重试不退避、最终超时，此时
    # rate_limited 仍为 False，但 timed_out 的提示会引导用户排查限流/网络。
    _RATE_LIMIT_HINTS = ("频率限制", "rate limit", "429", "quota", "请求过于频繁",
                         "too many requests", "频率过高")
    _blob = " ".join([(result["error"] or "")] + [e.get("text") or "" for e in events]).lower()
    result["rate_limited"] = any(h in _blob for h in _RATE_LIMIT_HINTS)
    if result["rate_limited"]:
        LOG.emit_current("探测结果包含限流特征：连接可达，但模型侧正在限流",
                         level="warn", source="probe")
    if result["ok"]:
        LOG.emit_current(f"一键测试通过（{result['elapsed_ms']}ms，{len(events)} 个事件）",
                         level="info", source="probe")
    else:
        LOG.emit_current(f"一键测试未通过（{result['elapsed_ms']}ms）："
                         f"{result['error'] or '未返回任何事件'}",
                         level="error", source="probe")
    return result
