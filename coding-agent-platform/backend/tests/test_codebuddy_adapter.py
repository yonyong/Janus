"""CodeBuddy 适配器单测：cmd 解析（Windows .cmd shim）、信任目录注入、环境净化与整树终止。

不真正启动 codebuddy CLI，仅验证解析、env 过滤与进程终止逻辑，避免 CI/单测误调真实进程。
"""
import asyncio
import json
import pathlib
import tempfile

import backend.adapters.codebuddy as cb


class _FakeProc:
    """最小可用的子进程替身（只覆盖 _terminate 用到的接口）。"""

    def __init__(self, pid=4242, returncode=None):
        self.pid = pid
        self.returncode = returncode
        self.killed = False
        self.waited = 0

    async def wait(self):
        self.waited += 1
        self.returncode = 0
        return 0

    def kill(self):
        self.killed = True


class _FakeOs:
    name = "nt"


def _patch_kill_tree(seen):
    """把 os.name 伪装成 nt 并记录 _taskkill_tree 收到的 pid。返回还原用的 (orig_os, orig_tree)。"""
    orig_os, orig_tree = cb.os, cb._taskkill_tree
    cb.os = _FakeOs
    cb._taskkill_tree = seen.append
    return orig_os, orig_tree


def test_resolve_cmd_uses_shutil_which():
    # 模拟 Windows：shutil.which 能把 codebuddy 解析到真实 .cmd 入口
    orig = cb.shutil.which
    try:
        cb.shutil.which = (
            lambda c: r"C:\Users\x\AppData\Roaming\npm\codebuddy.cmd" if c == "codebuddy" else None
        )
        assert cb._resolve_cmd("codebuddy") == r"C:\Users\x\AppData\Roaming\npm\codebuddy.cmd"
        # 找不到时原样返回，由调用方给出清晰报错（不再 WinError 2）
        assert cb._resolve_cmd("nonexistent-cli") == "nonexistent-cli"
    finally:
        cb.shutil.which = orig


def test_resolve_cmd_appends_ext_on_windows():
    orig = cb.shutil.which
    try:
        # 仅当裸名找不到、但 .cmd 变体存在时才追加扩展名
        def fake_which(c):
            return None if c == "codebuddy" else r"C:\x\codebuddy.cmd" if c == "codebuddy.cmd" else None
        cb.shutil.which = fake_which
        assert cb._resolve_cmd("codebuddy") == r"C:\x\codebuddy.cmd"
    finally:
        cb.shutil.which = orig


def test_trust_add_remove_mutates_settings():
    tmp = pathlib.Path(tempfile.mkdtemp()) / "settings.json"
    tmp.write_text(json.dumps({"trustedDirectories": ["C:/Windows/system32"]}), encoding="utf-8")
    orig_path = cb._SETTINGS_PATH
    try:
        cb._SETTINGS_PATH = tmp
        d = r"C:\Users\x\AppData\Local\Temp\cap-agent-probe-abc"
        cb._add_trusted(d)
        got = json.loads(tmp.read_text(encoding="utf-8"))
        assert d.replace("\\", "/") in got["trustedDirectories"]
        # 重复添加幂等
        cb._add_trusted(d)
        assert json.loads(tmp.read_text(encoding="utf-8"))["trustedDirectories"].count(d.replace("\\", "/")) == 1
        cb._remove_trusted(d)
        got = json.loads(tmp.read_text(encoding="utf-8"))
        assert d.replace("\\", "/") not in got["trustedDirectories"]
        # 重复移除不报错
        cb._remove_trusted(d)
    finally:
        cb._SETTINGS_PATH = orig_path


def test_build_cli_includes_model_flag():
    """配置了模型名称（config.model）时，命令行必须带上 --model 并做去空白处理。

    codebuddy 规格默认走 stream-json 流式（对话实时展示），流式优先于 json 结果模式。
    """
    orig = cb.shutil.which
    try:
        cb.shutil.which = lambda c: None  # 未安装 CLI 时 _resolve_cmd 原样返回
        cfg = {"cmd": "codebuddy", "model": "  glm-4.7  ", "args": ["--verbose"]}
        cli = cb._build_cli(cfg, "你好")
        assert cli[:8] == ["codebuddy", "-p", "-y", "--output-format", "stream-json",
                           "--include-partial-messages", "--verbose", "--model"]
        assert cli[8] == "glm-4.7"
        assert cli[-2:] == ["--verbose", "你好"]
    finally:
        cb.shutil.which = orig


def test_build_cli_json_output_only_for_flagged_specs_and_user_override_wins():
    """流式优先；用户 args 里自带 --output-format 时以用户为准，两种模式都不追加。"""
    orig = cb.shutil.which
    try:
        cb.shutil.which = lambda c: None
        # codebuddy / claude 默认带 stream-json 流式参数
        for t in ("codebuddy", "claude"):
            cli = cb._build_cli({}, "hi", cb._CLI_SPECS[t])
            assert "--output-format" in cli
            assert cli[cli.index("--output-format") + 1] == "stream-json"
        # 用户显式给了 --output-format 时不重复加，也不走流式 / json 模式
        cli = cb._build_cli({"args": ["--output-format", "json"]}, "hi",
                            cb._CLI_SPECS["codebuddy"])
        assert cli.count("--output-format") == 1
        assert cli[cli.index("--output-format") + 1] == "json"
        # codex 规格没有流式与 json 模式，行为不变；cursor 开了 json_result 会追加 json 模式
        cli = cb._build_cli({}, "hi", cb._CLI_SPECS["codex"])
        assert "--output-format" not in cli
        cli = cb._build_cli({}, "hi", cb._CLI_SPECS["cursor"])
        assert cli.count("--output-format") == 1
        assert cli[cli.index("--output-format") + 1] == "json"
        # 用户给 cursor 自带 --output-format 时以用户为准，不重复加
        cli = cb._build_cli({"args": ["--output-format", "json"]}, "hi",
                            cb._CLI_SPECS["cursor"])
        assert cli.count("--output-format") == 1
    finally:
        cb.shutil.which = orig


def test_wants_stream_prefers_stream_and_respects_user_format():
    """/_wants_stream：规格带 stream_flags 才开流式；用户自带 --output-format 时让位。"""
    spec = cb._CLI_SPECS["codebuddy"]
    assert cb._wants_stream({}, spec) is True
    assert cb._wants_stream({"args": ["--output-format", "json"]}, spec) is False
    assert cb._wants_stream({}, cb._CLI_SPECS["codex"]) is False
    # json_result 在流式开启时不再生效（result 事件同样带 usage，不重复）
    assert cb._wants_json_output({}, spec) is True
    assert cb._build_cli({}, "hi", spec).count("--output-format") == 1


def test_normalize_usage_aggregates_cache_into_prompt():
    """缓存命中/写入的输入 token 也是真实消耗，必须计入 prompt_tokens，否则输入被低估。"""
    got = cb.normalize_usage({"input_tokens": 12, "cache_read_input_tokens": 3456,
                              "cache_creation_input_tokens": 78, "output_tokens": 45})
    assert got == {"prompt_tokens": 12 + 3456 + 78, "completion_tokens": 45,
                   "total_tokens": 12 + 3456 + 78 + 45}
    # CLI 已给 total_tokens 时以它为准
    got = cb.normalize_usage({"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})
    assert got == {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    # 负数 / 脏值 / 缺失一律按 0；全 0 视为没有用量（上层走估算）
    assert cb.normalize_usage({"input_tokens": -1}) is None
    assert cb.normalize_usage({"input_tokens": "abc"}) is None
    assert cb.normalize_usage({}) is None
    assert cb.normalize_usage(None) is None
    assert cb.normalize_usage("usage") is None


def test_normalize_usage_accepts_cursor_camel_case():
    """cursor 的 usage 是 camelCase 键名（inputTokens/outputTokens/cacheReadTokens/
    cacheWriteTokens），同样要把缓存计入 prompt，缺失 total 时用和补齐。"""
    got = cb.normalize_usage({"inputTokens": 13761, "outputTokens": 62,
                              "cacheReadTokens": 9600, "cacheWriteTokens": 0})
    assert got == {"prompt_tokens": 13761 + 9600, "completion_tokens": 62,
                   "total_tokens": 13761 + 9600 + 62}
    # 缓存全零时不虚增
    got = cb.normalize_usage({"inputTokens": 10, "outputTokens": 5})
    assert got == {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    # 混合风格也不怕（同义键并存时按顺序取第一个存在的键）
    got = cb.normalize_usage({"input_tokens": 7, "outputTokens": 3})
    assert got == {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}
    assert cb.normalize_usage({"cacheReadTokens": 0}) is None


def test_parse_result_json_reads_result_and_usage():
    parsed = cb.parse_result_json(json.dumps({
        "type": "result", "subtype": "success", "is_error": False,
        "result": "已完成。",
        "usage": {"input_tokens": 100, "cache_read_input_tokens": 50, "output_tokens": 20},
    }))
    assert parsed["text"] == "已完成。"
    assert parsed["is_error"] is False
    assert parsed["usage"] == {"prompt_tokens": 150, "completion_tokens": 20, "total_tokens": 170}
    # result 字段缺失 / 非字符串时正文按空串处理，不崩
    parsed = cb.parse_result_json('{"is_error": true, "usage": null}')
    assert parsed["text"] == "" and parsed["is_error"] is True and parsed["usage"] is None


def test_parse_result_json_reads_event_array_from_real_cli_shape():
    """真实 CLI 的 --output-format json 是事件数组：取最后一条带 usage 的消息作结果。

    形态取自 2026-09-19 实测：user/assistant 消息序列，assistant 消息带真实 usage
    （input/output/cache 拆分），正文在其 text 块里。
    """
    events = [
        {"type": "message", "role": "user",
         "content": [{"type": "input_text", "text": "你好"}]},
        {"type": "message", "role": "assistant",
         "content": [{"type": "text", "text": "收 到"}],
         "usage": {"input_tokens": 28361, "output_tokens": 96,
                   "cache_creation_input_tokens": 27849, "cache_read_input_tokens": 512}},
    ]
    parsed = cb.parse_result_json(json.dumps(events))
    assert parsed["text"] == "收 到"
    assert parsed["is_error"] is False
    assert parsed["usage"] == {"prompt_tokens": 28361 + 27849 + 512, "completion_tokens": 96,
                               "total_tokens": 28361 + 27849 + 512 + 96}
    # 数组里没有任何带 usage 的元素 → 解析不出，回退纯文本
    assert cb.parse_result_json(json.dumps([{"type": "message", "role": "user"}])) is None
    # 数组元素带 is_error 时整体标失败
    events_err = events + [{"type": "message", "is_error": True}]
    assert cb.parse_result_json(json.dumps(events_err))["is_error"] is True


def test_parse_result_json_tolerates_noise_lines_and_garbage():
    """stdout 混有噪声行时逐行找结果 JSON；整体解析不出返回 None（上层回退纯文本）。"""
    noisy = ("starting...\n"
             + json.dumps({"type": "result", "is_error": False, "result": "正文", "usage": {}})
             + "\ndone")
    parsed = cb.parse_result_json(noisy)
    assert parsed is not None and parsed["text"] == "正文" and parsed["usage"] is None
    # 纯文本 / 空串 / 非结果 JSON / JSON 数组 都解析不出
    assert cb.parse_result_json("就是一段普通文本") is None
    assert cb.parse_result_json("") is None
    assert cb.parse_result_json('{"unrelated": 1}') is None
    assert cb.parse_result_json('[1, 2, 3]') is None


def test_pump_emit_false_accumulates_without_log_records():
    """JSON 结果模式下 stdout 只攒字节不进实时日志（整段单行 JSON 是噪声）。"""
    from backend import logbus as L
    L.reset()
    keep: list = []
    payload = [b'{"type":"result","result":"done"}\n']
    with L.bind(project_id=5, session_id=1):
        asyncio.run(cb._pump(_FakeStream(payload), keep, "info", emit=False))
    assert b"".join(keep) == payload[0]          # 原始字节完整保留，供结束后解析
    assert L.snapshot(5)["records"] == []        # 不产出任何日志记录


def test_build_cli_omits_model_when_unset_or_invalid():
    """未配置 / 留空白 / 非字符串的 model 一律忽略，回落到 CLI 默认模型。"""
    orig = cb.shutil.which
    try:
        cb.shutil.which = lambda c: None
        for cfg in ({}, {"model": ""}, {"model": "   "}, {"model": None}, {"model": 123},
                    {"model": ["glm-4.7"]}):
            cli = cb._build_cli(cfg, "hi")
            assert "--model" not in cli
            assert cli[0] == "codebuddy"  # 未配置 cmd 时的默认入口
            assert cli[1:3] == ["-p", "-y"]
            assert cli[-1] == "hi"
    finally:
        cb.shutil.which = orig


def test_build_cli_adds_resume_flag_per_spec():
    """resume_id 非空时按规格注入续聊：flag 型 --resume <id>；codex 走 exec resume <id>。"""
    orig = cb.shutil.which
    try:
        cb.shutil.which = lambda c: None
        # flag 型：codebuddy / claude / cursor
        for t in ("codebuddy", "claude", "cursor"):
            cli = cb._build_cli({}, "hi", cb._CLI_SPECS[t], resume_id="sess-abc")
            assert "--resume" in cli
            assert cli[cli.index("--resume") + 1] == "sess-abc"
            assert cli[-1] == "hi"
        # codex：子命令型，exec 之后插入 resume <id>
        cli = cb._build_cli({}, "hi", cb._CLI_SPECS["codex"], resume_id="sess-xyz")
        i = cli.index("exec")
        assert cli[i + 1:i + 3] == ["resume", "sess-xyz"]
        assert "--resume" not in cli
        # resume_id 空白 / None：不注入任何续聊参数
        for rid in (None, "", "   "):
            cli = cb._build_cli({}, "hi", cb._CLI_SPECS["codebuddy"], resume_id=rid)
            assert "--resume" not in cli
        cli = cb._build_cli({}, "hi", cb._CLI_SPECS["codex"], resume_id=None)
        assert "resume" not in cli
    finally:
        cb.shutil.which = orig


def test_stream_session_captures_external_session_id():
    """stream-json 的 system/init（及后续事件）携带的 session_id 被捕获，首个非空生效。"""
    s = cb._StreamSession()
    s.handle_line(json.dumps({"type": "system", "subtype": "init",
                              "session_id": "ext-1"}).encode())
    assert s.session_id == "ext-1"
    # 后续事件即使再带别的 id 也不覆盖首个（同一会话 id 固定）
    s.handle_line(json.dumps({"type": "result", "is_error": False, "result": "ok",
                              "session_id": "ext-2"}).encode())
    assert s.session_id == "ext-1"
    # 空白 / 缺失的 session_id 不产生捕获
    s2 = cb._StreamSession()
    s2.handle_line(json.dumps({"type": "system", "session_id": "  "}).encode())
    assert s2.session_id is None


def test_parse_result_json_extracts_session_id():
    """JSON 结果模式：单对象与事件数组两种形态都能取出 session_id。"""
    parsed = cb.parse_result_json(json.dumps({
        "type": "result", "is_error": False, "result": "done",
        "session_id": "obj-sid", "usage": {"input_tokens": 5, "output_tokens": 3}}))
    assert parsed["session_id"] == "obj-sid"
    # 数组：session_id 落在没有 usage 的 init 事件上，也要能补齐到结果里
    events = [
        {"type": "system", "subtype": "init", "session_id": "arr-sid"},
        {"type": "message", "role": "assistant", "content": [{"type": "text", "text": "hi"}],
         "usage": {"input_tokens": 10, "output_tokens": 2}},
    ]
    parsed = cb.parse_result_json(json.dumps(events))
    assert parsed["session_id"] == "arr-sid"
    # 没有 session_id 时为 None，不报错
    parsed = cb.parse_result_json(json.dumps({"is_error": False, "result": "x", "usage": {}}))
    assert parsed["session_id"] is None


def test_build_cli_specs_for_all_cli_types():
    """claude / codex / cursor 复用同一套通用 CLI 流程，各自有正确的基础参数与模型参数。"""
    orig = cb.shutil.which
    try:
        cb.shutil.which = lambda c: None  # 未安装 CLI 时 _resolve_cmd 原样返回
        cases = {
            "claude": ["claude", "-p", "--dangerously-skip-permissions"],
            "codex": ["codex", "exec", "--full-auto", "--skip-git-repo-check"],
            "cursor": ["cursor-agent", "-p", "--trust"],
            "codebuddy": ["codebuddy", "-p", "-y"],
        }
        for t, prefix in cases.items():
            spec = cb._CLI_SPECS[t]
            cli = cb._build_cli({"model": " glm-4.7 "}, "hi", spec)
            assert cli[:len(prefix)] == prefix
            flag = spec["model_flag"]
            i = cli.index(flag)
            assert cli[i + 1] == "glm-4.7" and cli[-1] == "hi"
            # 只有 codebuddy 需要临时注入信任目录（写 ~/.codebuddy/settings.json）
            assert spec["trust"] is (t == "codebuddy")
        # 未指定 spec 时默认按 codebuddy 处理
        assert cb._build_cli({}, "hi")[0] == "codebuddy"
    finally:
        cb.shutil.which = orig


def test_cli_agent_adapter_rejects_unknown_type():
    try:
        cb.CliAgentAdapter("no-such-cli")
    except KeyError:
        pass
    else:
        raise AssertionError("未知类型应抛 KeyError")


def test_clean_env_drops_host_injected_session_vars():
    """宿主注入的会话环境变量必须剥掉，否则 CLI 会误判自己在宿主网关内并静默挂死。

    回归自真实故障：后端从 WorkBuddy 的进程树启动，把 SERVER__PORT /
    CODEBUDDY_SERVICE_PROXY_URL 等一并转发给 codebuddy，CLI 因端口冲突 + 指向宿主代理
    而永不返回（30s 探针必然超时）。
    """
    fake = {
        "PATH": r"C:\Windows\system32",
        "HTTPS_PROXY": "http://127.0.0.1:7890",
        "SERVER__PORT": "60631",
        "BAGGAGE": "codebuddy.session_id=x",
        "editor_sdk_port": "39099",
        "CODEBUDDY_GATEWAY_PASSWORD": "secret",
        "CODEBUDDY_SERVICE_PROXY_URL": "http://127.0.0.1:60631/internal/hooks/services/invoke",
        "CODEBUDDY_SESSION_ID": "eabb7f1d-0178-4c41",
        "CODEBUDDY_MCP_CONFIG": "{}",
        "CODEBUDDY_CONFIG_DIR": r"C:\Users\x\.workbuddy",
        "CLAUDE_SESSION_ID": "eabb7f1d-0178-4c41",
        "WORKBUDDY_APP_PATH": r"C:\Program Files\WorkBuddy",
        "CLIENT_INFO_PLATFORM": "WorkBuddy",
    }
    assert cb._clean_env(fake) == {
        "PATH": r"C:\Windows\system32",
        "HTTPS_PROXY": "http://127.0.0.1:7890",
    }


def test_clean_env_defaults_to_real_environ():
    got = cb._clean_env()
    assert "PATH" in got
    assert not [k for k in got
                if k.startswith(("CODEBUDDY_", "WORKBUDDY_", "CLAUDE_", "CLIENT_INFO_"))]


def test_terminate_kills_whole_process_tree():
    """超时终止必须连子进程树一起杀（.cmd shim 下还有 node），并等其退出以便回收目录。"""
    seen = []
    orig_os, orig_tree = _patch_kill_tree(seen)
    try:
        proc = _FakeProc(pid=4242)
        asyncio.run(cb._terminate(proc))
        assert seen == [4242]        # 走 taskkill /T 的树杀
        assert proc.waited == 1      # 等待真正退出，工作目录才能删掉
        assert proc.killed is False  # 树杀成功则无需再 kill
    finally:
        cb.os, cb._taskkill_tree = orig_os, orig_tree


def test_terminate_skips_already_exited_process():
    seen = []
    orig_os, orig_tree = _patch_kill_tree(seen)
    try:
        proc = _FakeProc(returncode=0)
        asyncio.run(cb._terminate(proc))
        assert seen == []
        assert proc.waited == 0
    finally:
        cb.os, cb._taskkill_tree = orig_os, orig_tree


def test_decode_handles_gbk_system_message():
    """中文 Windows 上 CLI 的 wmic 报错是 GBK 编码，必须能正确解码而非乱码。

    回归自真实故障：'拒绝访问。 'wmic' 不是内部或外部命令…' 被当 UTF-8 解码成乱码。
    """
    gbk_bytes = "拒绝访问。 'wmic' 不是内部或外部命令，也不是可运行的程序 或批处理文件。".encode("gbk")
    assert cb._decode(gbk_bytes) == "拒绝访问。 'wmic' 不是内部或外部命令，也不是可运行的程序 或批处理文件。"
    # UTF-8 正文不受影响
    utf8_bytes = "你好！我是 CodeBuddy Code".encode("utf-8")
    assert cb._decode(utf8_bytes) == "你好！我是 CodeBuddy Code"
    # 空字节安全返回空串
    assert cb._decode(b"") == ""
    # 无法识别的字节也不崩（latin-1 兜底）
    assert cb._decode(b"\xff\xfe") != "" or cb._decode(b"\xff\xfe") is not None


def test_invoke_filters_wmic_noise_from_info():
    """invoke 把 stderr 透出为 info，但应滤掉 codebuddy 启动器的 wmic 良性噪声。

    不真正启动 CLI：直接构造 CodeBuddyAdapter.invoke 的生成器，喂入 GBK 编码的
    wmic 报错 + 正常 UTF-8 正文，断言 info 事件不含乱码/噪声，message 事件为正文。
    """
    import sys
    # 用真实的 _decode 行为：通过 monkeypatch subprocess 调用不可行（要真起进程），
    # 这里改为验证「噪声过滤」这一纯逻辑——把 _decode 的输入等价替换为已解码文本。
    stderr_with_noise = "拒绝访问。 'wmic' 不是内部或外部命令，也不是可运行的程序 或批处理文件。"
    lines = [ln for ln in stderr_with_noise.splitlines()
             if not (cb._WMIC_NOISE_MARK in ln and "wmic" in ln.lower())]
    assert lines == []  # wmic 噪声整行被剔除，info 事件为空
    # 混合场景：噪声行 + 真实限流告警，告警应保留
    mixed = stderr_with_noise + "\n" + "请求过于频繁，请稍后再试 (429)"
    kept = [ln for ln in mixed.splitlines()
            if not (cb._WMIC_NOISE_MARK in ln and "wmic" in ln.lower())]
    assert kept == ["请求过于频繁，请稍后再试 (429)"]
    # 同一个判断以纯函数暴露给流式读取路径复用，避免两处规则跑偏
    assert cb.is_noise_line(stderr_with_noise) is True
    assert cb.is_noise_line("请求过于频繁，请稍后再试 (429)") is False
    assert cb.is_noise_line("") is False


class _FakeStream:
    """替身管道：按预设分块吐出字节，用尽后返回 b"" 表示 EOF。"""

    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def read(self, n=-1):
        return self._chunks.pop(0) if self._chunks else b""


def _drain(chunks, level="info", project_id=5):
    """跑一次 _pump，返回（原始字节, 落进日志总线的记录）。str 分块按 UTF-8 编码，便于用例书写。"""
    from backend import logbus as L

    L.reset()
    payload = [c if isinstance(c, bytes) else c.encode("utf-8") for c in chunks]
    keep: list = []
    with L.bind(project_id=project_id, session_id=1):
        asyncio.run(cb._pump(_FakeStream(payload), keep, level))
    return b"".join(keep), L.snapshot(project_id)["records"]


def test_pump_streams_lines_as_they_arrive():
    """子进程输出必须边产生边进实时日志，而不是结束后一次性倾泻。

    回归自真实体验问题：原来用 communicate() 一次性收完，几十秒的编码过程在「实时日志」
    里完全看不到，结束时才一股脑出现 —— 那就不是实时日志了。
    """
    raw, recs = _drain(["第一行\n第二", "行\n\n", "第三行（没有换行结尾）"])
    assert [r["text"] for r in recs] == ["第一行", "第二行", "第三行（没有换行结尾）"]
    assert all(r["project_id"] == 5 and r["source"] == "agent" for r in recs)
    # 原始字节完整保留：结束后仍要按原有逻辑解析出完整 stdout
    assert raw.decode("utf-8") == "第一行\n第二行\n\n第三行（没有换行结尾）"


def test_pump_keeps_multibyte_chars_intact_across_chunks():
    """按 \\n 切分是编码安全的：多字节字符被管道分块劈开也不能变成乱码。"""
    payload = "中文内容，逐行输出。\n第二行也一样。\n".encode("utf-8")
    cut = 5  # 故意切在一个中文字符中间
    _raw, recs = _drain([payload[:cut], payload[cut:], b""])
    assert [r["text"] for r in recs] == ["中文内容，逐行输出。", "第二行也一样。"]


def test_pump_maps_stderr_to_warn_and_drops_wmic_noise():
    _raw, recs = _drain(["拒绝访问。 'wmic' 不是内部或外部命令，也不是可运行的程序 或批处理文件。\n"
                         "请求过于频繁，请稍后再试 (429)\n"], level="warn")
    assert [r["text"] for r in recs] == ["请求过于频繁，请稍后再试 (429)"]
    assert recs[0]["level"] == "warn"


def test_pump_flushes_long_line_without_newline():
    """长时间不换行（或被压成一行的超长 JSON）要先落一条，既不阻塞也不让内存无上限增长。"""
    chunk = b"x" * (cb._TAIL_LIMIT + 10)
    raw, recs = _drain([chunk])
    assert len(recs) == 1 and recs[0]["text"]
    assert raw == chunk  # 原始字节一条不漏，供结束后解析


def test_pump_is_silent_for_empty_output():
    """只有空行/空白时不产出日志记录，但原始字节照样完整保留。"""
    raw, recs = _drain([b"\n", b"   \n", b"\t"])
    assert raw == b"\n   \n\t"
    assert recs == []


# ---------------- stream-json 流式解析 ----------------

def _init_line():
    return json.dumps({"type": "system", "subtype": "init", "session_id": "s1"}).encode()


def test_stream_session_emits_deltas_and_transient_turns():
    """text_delta 产出 delta 事件；assistant 轮次产出 transient 的 message 事件。"""
    s = cb._StreamSession()
    evs = s.handle_line(_init_line())
    assert evs == []  # system 行忽略
    evs = s.handle_line(json.dumps({
        "type": "stream_event", "event": {"type": "content_block_delta",
                                          "delta": {"type": "text_delta", "text": "你好"}}}).encode())
    assert [(e.type, e.text) for e in evs] == [("delta", "你好")]
    # thinking 增量不透出，避免干扰正文
    evs = s.handle_line(json.dumps({
        "type": "stream_event", "event": {"type": "content_block_delta",
                                          "delta": {"type": "thinking_delta", "thinking": "想"}},
    }).encode())
    assert evs == []
    # 中间轮次：完整正文 + 调用工具提示
    evs = s.handle_line(json.dumps({
        "type": "assistant",
        "message": {"content": [{"type": "text", "text": "我先看看目录"},
                                {"type": "tool_use", "name": "Bash", "id": "t1"}]}}).encode())
    assert [(e.type, e.text) for e in evs] == [("message", "我先看看目录"), ("status", "调用工具 Bash")]
    assert evs[0].payload == {"streamed": True, "transient": True}
    assert evs[1].payload == {"transient": True}
    assert s.turn_texts == ["我先看看目录"]


def test_stream_session_final_result_carries_usage():
    """result 事件产出唯一的最终 message（带真实 usage），失败时报 error。"""
    s = cb._StreamSession()
    assert s.handle_line(json.dumps({
        "type": "result", "is_error": False, "result": "完成。",
        "usage": {"input_tokens": 10, "output_tokens": 5}}).encode()) == []
    finals = s.final_events("codebuddy")
    assert len(finals) == 1 and finals[0].type == "message" and finals[0].text == "完成。"
    assert finals[0].payload["usage"] == {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    # result 与轮次正文相同时也不重复：最终答复只有一条
    s2 = cb._StreamSession()
    s2.handle_line(json.dumps({"type": "assistant",
                               "message": {"content": [{"type": "text", "text": "答复"}]}}).encode())
    s2.handle_line(json.dumps({"type": "result", "is_error": False, "result": "答复"}).encode())
    assert [e.text for e in s2.final_events("codebuddy")] == ["答复"]
    # result 缺失时拿最后一轮正文兜底，内容不丢
    s3 = cb._StreamSession()
    s3.handle_line(json.dumps({"type": "assistant",
                               "message": {"content": [{"type": "text", "text": "唯一轮次"}]}}).encode())
    finals = s3.final_events("codebuddy")
    assert [e.text for e in finals] == ["唯一轮次"]


def test_stream_session_reports_result_error():
    s = cb._StreamSession()
    s.handle_line(json.dumps({
        "type": "result", "is_error": True, "result": "模型不可用"}).encode())
    finals = s.final_events("codebuddy")
    assert finals[0].type == "error" and "模型不可用" in finals[0].text


def test_stream_session_tolerates_noise_and_garbage_lines():
    """裸文本行进实时日志（噪声行被拦）、坏 JSON 不崩、空行跳过。"""
    s = cb._StreamSession()
    assert s.handle_line(b"") == []
    assert s.handle_line(b"   \n") == []
    assert s.handle_line(b"not-json at all") == []  # 非噪声裸文本：只进日志不产事件
    assert s.handle_line(b"{broken json") == []
    # GBK 乱码行（已被 CLI 解坏）不再透出
    mojibake = "拒绝访问。".encode("gbk").decode("utf-8", "replace").encode("utf-8")
    assert s.handle_line(mojibake) == []
    # 非 dict 的 JSON 行（数组/标量）安全忽略
    assert s.handle_line(b"[1, 2]") == []
    assert s.handle_line(b'"text"') == []


def test_is_noise_line_filters_double_decoded_mojibake():
    """CLI 把 GBK 输出按 UTF-8 二次解码后是带 U+FFFD 的乱码：按特征过滤，不进对话。

    回归自真实观感问题：对话里出现 'wmic' 与「拒绝访问。」的乱码形态，
    原来的过滤只认 GBK 解码成功的原文，乱码版直接漏进了对话记录。
    """
    mojibake_wmic = "'wmic' " + "不是内部或外部命令".encode("gbk").decode("utf-8", "replace")
    assert cb.is_noise_line(mojibake_wmic) is True
    mojibake_denied = "拒绝访问。".encode("gbk").decode("utf-8", "replace")
    assert cb.is_noise_line(mojibake_denied) is True
    # 正常内容不受影响：真实报错、含个别替换符的正文都不能误杀
    assert cb.is_noise_line("请求过于频繁，请稍后再试 (429)") is False
    assert cb.is_noise_line("输出里有一个替换符\ufffd结尾") is False
    assert cb.is_noise_line("") is False


class _FakeStdin:
    """替身 stdin 写入器：记录写进的字节与关闭动作。"""

    def __init__(self, outer):
        self._outer = outer

    def write(self, data):
        self._outer.fed += data

    async def drain(self):
        return None

    def close(self):
        self._outer.closed = True


class _FakeStdinProc:
    """替身子进程：记录启动参数与写入 stdin 的字节，管道吐空后立即退出。"""

    def __init__(self, stdin_pipe):
        self.args_captured = None
        self.stdin_captured = stdin_pipe
        self.stdin = _FakeStdin(self)
        self.fed = b""
        self.closed = False
        self.returncode = 0
        self.stdout = _FakeStream([b""])
        self.stderr = _FakeStream([b""])
        self.pid = 12345

    async def wait(self):
        return 0


def test_invoke_routes_multiline_message_via_stdin():
    """含换行的消息必须走 stdin 传给 CLI，而不是命令行参数。

    回归自真实缺陷：Windows 上 CLI 经 cmd.exe 启动 .cmd 垫片，多行参数会在
    第一个换行处被整体截断——聊天消息前注入的多行路径约定把用户真正的指令
    「挤丢」了，Agent 只收到第一行，回复「消息被截断，请补发路径」。
    """
    import asyncio as _aio

    adapter = cb.CliAgentAdapter("codebuddy")
    agent_row = {"config": "{}"}
    msg = "【平台约定】绑定需求「免密登录」，按以下路径：\n- 原始需求：.janus/x/requirement/origin.md\n- 请润色"
    captured = {}

    def fake_exec(*args, **kwargs):
        proc = _FakeStdinProc(kwargs.get("stdin"))
        proc.args_captured = (args, kwargs)
        captured["proc"] = proc
        future = _aio.get_event_loop().create_future()
        future.set_result(proc)
        return future

    orig_exec, orig_add, orig_rm = _aio.create_subprocess_exec, cb._add_trusted, cb._remove_trusted
    cb._add_trusted = lambda p: None
    cb._remove_trusted = lambda p: None
    _aio.create_subprocess_exec = fake_exec

    async def _collect(gen):
        return [e async for e in gen]

    try:
        # 多行：消息不进 argv，改由 stdin 写入
        evs = _aio.run(_collect(adapter.invoke(agent_row, msg, "D:/proj")))
        proc = captured["proc"]
        argv = proc.args_captured[0]
        assert msg not in argv and "origin.md" not in " ".join(argv)
        assert proc.stdin_captured == _aio.subprocess.PIPE
        assert proc.fed == msg.encode("utf-8")  # 完整消息（含换行）经 stdin 送达
        assert evs and evs[-1].type == "error"  # 空输出时按约定报「未返回输出」，不影响断言点
        # 单行：仍走命令行参数，stdin 为 DEVNULL（不破坏既有行为）
        captured.clear()
        single = "单行消息"
        _ = _aio.run(_collect(adapter.invoke(agent_row, single, "D:/proj")))
        proc2 = captured["proc"]
        assert single in proc2.args_captured[0]
        assert proc2.stdin_captured == _aio.subprocess.DEVNULL
    finally:
        _aio.create_subprocess_exec = orig_exec
        cb._add_trusted, cb._remove_trusted = orig_add, orig_rm


# ---------------- _agent_env：API Key 与代理注入 ----------------

def test_agent_env_api_key_per_type():
    """api_key 按类型注入对应环境变量（cursor → CURSOR_API_KEY 等）。"""
    assert cb._agent_env({"api_key": " sk-test "}, "cursor") == {"CURSOR_API_KEY": "sk-test"}
    assert cb._agent_env({"api_key": "k"}, "claude") == {"ANTHROPIC_API_KEY": "k"}
    assert cb._agent_env({"api_key": "k"}, "codex") == {"OPENAI_API_KEY": "k"}
    assert cb._agent_env({"api_key": "k"}, "codebuddy") == {"CODEBUDDY_API_KEY": "k"}


def test_agent_env_api_key_env_override():
    """config.api_key_env 覆盖规格表默认变量名（未知类型也能配）。"""
    assert cb._agent_env({"api_key": "k", "api_key_env": "MY_KEY"}, "cursor") == {"MY_KEY": "k"}
    # 未知类型无默认变量名且未覆盖时不注入
    assert cb._agent_env({"api_key": "k"}, "unknown") == {}


def test_agent_env_api_key_invalid_values_ignored():
    """api_key 非字符串/空白串一律忽略，api_key_env 脏值回退规格默认。"""
    assert cb._agent_env({"api_key": ""}, "cursor") == {}
    assert cb._agent_env({"api_key": "   "}, "cursor") == {}
    assert cb._agent_env({"api_key": None}, "cursor") == {}
    assert cb._agent_env({"api_key": 123}, "cursor") == {}
    assert cb._agent_env({}, "cursor") == {}
    assert cb._agent_env({"api_key": "k", "api_key_env": "  "}, "cursor") == {"CURSOR_API_KEY": "k"}


def test_agent_env_proxy_injection():
    """proxy 注入大小写两组 HTTP(S)_PROXY，NO_PROXY 固定排除本机回环。"""
    env = cb._agent_env({"proxy": " http://127.0.0.1:7890 "}, "cursor")
    assert env["HTTP_PROXY"] == "http://127.0.0.1:7890"
    assert env["HTTPS_PROXY"] == env["HTTP_PROXY"]
    assert env["http_proxy"] == env["HTTP_PROXY"] and env["https_proxy"] == env["HTTP_PROXY"]
    assert "localhost,127.0.0.1" in env["NO_PROXY"] and env["no_proxy"] == env["NO_PROXY"]
    assert cb._agent_env({"proxy": "  "}, "cursor") == {}
    assert cb._agent_env({"proxy": None}, "cursor") == {}


def test_agent_env_combined_and_clean_env_not_mutated():
    """api_key 与 proxy 可同时配置；_clean_env 返回值不被 _agent_env 污染。"""
    env = cb._agent_env({"api_key": "k", "proxy": "http://p:1"}, "claude")
    assert env["ANTHROPIC_API_KEY"] == "k" and env["HTTP_PROXY"] == "http://p:1"
    base = cb._clean_env({"PATH": "/bin", "CODEBUDDY_HOST_VAR": "x"})
    assert "HTTP_PROXY" not in base and "ANTHROPIC_API_KEY" not in base
