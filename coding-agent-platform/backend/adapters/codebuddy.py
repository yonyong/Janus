"""CodeBuddy 适配器：以子进程方式启动 CodeBuddy CLI（非交互 -p 模式）并解析其输出。

与 CLI 真实联调后的最终实现（取代原 JSON-stdin 占位约定）：

- 启动方式：``codebuddy -p -y "<message>"``
  - ``-p``  非交互打印模式（服务端无 TTY，必须）
  - ``-y``  跳过权限提示（探测只发一条「你好」，不触发危险操作）
- 环境净化（**关键**）：宿主（WorkBuddy / CodeBuddy 桌面端）会往其子进程注入一整套
  自己的会话环境变量；本后端若从宿主的终端/进程树里启动，就会把它们原样继承下来并
  再转发给被拉起的 CLI。CLI 于是误判自己运行在宿主网关内部 —— ``SERVER__PORT`` 指向
  宿主已占用的端口（实测 ``EADDRINUSE 127.0.0.1:60631``）、``CODEBUDDY_SERVICE_PROXY_URL``
  指向宿主的服务代理、还带着宿主的 Gateway 口令与会话/MCP 配置 —— 结果 CLI 静默挂死：
  一行输出都没有、CPU 近 0、150s 也不返回（30s 探针必然超时）。因此这里把宿主相关的
  变量整批剥掉，等价于「在普通终端里手动运行」，详见 ``_clean_env``。
- 信任门禁：CodeBuddy 在非信任目录会交互式询问「是否信任此文件夹」并卡死。
  ``--settings`` 注入的 trustedDirectories 不生效，信任只认全局
  ``~/.codebuddy/settings.json``。因此这里在启动前把工作目录临时加入全局
  trustedDirectories，子进程结束后移除（加锁 + 崩溃残留清理，安全可逆，不改用户其他配置）。
- Windows 注意：``codebuddy`` 是 npm 安装的 ``.cmd`` shim，``create_subprocess_exec``
  不做 PATHEXT 解析，必须用 ``shutil.which`` 解析到真实入口，否则 ``FileNotFoundError``。
- 探测/调用被取消（如一键测试超时）时**必须连子进程树一起杀**：``.cmd`` shim 之下还有
  真正的 node 进程，只 kill 直接子进程会留下孤儿——孤儿继续占着 stdout 管道与工作目录，
  导致临时目录删不掉、进程越积越多。见 ``_terminate``。
- 输出**边产生边推送**：``_pump`` 逐块读取 stdout/stderr，按行送进实时日志总线
  （``source="agent"``），同时把原始字节攒起来供结束后按原有逻辑解析。原来用
  ``communicate()`` 一次性收完 —— 那样几十秒的编码过程在「实时日志」里完全看不到，
  只剩最后一次性倾泻。注意不能改用 ``readline()``：CLI 输出进度时可能长时间不换行，
  读行会一直等下去，看起来像卡死。
- **token 真实用量**：以 ``--output-format json`` 调用（仅 json_result 规格启用），
  stdout 是单个结果 JSON，内含 ``result``（模型正文）与 ``usage``（真实 token 用量）。
  解析成功时正文照常产出 message 事件、usage 放进 payload，由 agent_test / session_service
  透传给审计留痕 —— 这样调用详情页显示的就是真实用量而不是估算。解析失败时整段回退到
  纯文本路径（行为与旧版一致），保证 CLI 版本差异不会把调用搞挂。JSON 模式下 stdout
  不逐行进实时日志（整段单行 JSON 是噪声），解析成功后由 message 事件补上正文。
"""
import asyncio
import contextlib
import json
import os
import pathlib
import shutil
import subprocess
import threading

from backend import logbus as LOG
from backend.agent_runtime import AgentEvent

_SETTINGS_PATH = pathlib.Path.home() / ".codebuddy" / "settings.json"
_SETTINGS_LOCK = threading.Lock()
_TRUST_MARKER = "cap-agent-probe-"  # 仅用于清理探针遗留项；真实项目目录不会被误删

# 宿主注入、必须剥离的环境变量（见模块 docstring）
_HOST_ENV_DROP_EXACT = {"SERVER__PORT", "BAGGAGE", "editor_sdk_port"}
_HOST_ENV_DROP_PREFIXES = ("CODEBUDDY_", "CLAUDE_", "CLIENT_INFO_", "WORKBUDDY_")

# codebuddy 的 .cmd 启动器在中文 Windows 上会去调已废弃的 wmic，并打印
# 「'wmic' 不是内部或外部命令…」（GBK）。与用户任务无关，属良性噪声，从 info 中剔除。
# 注意：CLI 自身（node）会先把它捕获到的 GBK 子进程输出按 UTF-8 二次解码再转发，
# 到我们手里时已经是带 U+FFFD 的乱码（GBK 信息已丢失），无法按原文匹配 —— 所以
# 这里同时按「包含 wmic 字样」和「乱码密度」两种特征过滤（见 is_noise_line）。
_WMIC_NOISE_MARK = "不是内部或外部命令"

# 读取子进程输出时，未以换行结束的尾巴最多攒这么多字节就先落一条日志，
# 避免一条超长（或被压成一行的 JSON）输出把内存占满、也避免长时间看不到任何输出。
_TAIL_LIMIT = 64 * 1024
_READ_CHUNK = 8192


def _clean_env(environ=None) -> dict:
    """剥掉宿主注入的会话环境变量，只保留用户自己的环境。

    保留 PATH/HOME/代理等一切与宿主无关的变量；被剥离的只有宿主进程自己加的那批
    （前缀见 ``_HOST_ENV_DROP_PREFIXES``）。纯函数，便于单测。
    """
    src = os.environ if environ is None else environ
    return {
        k: v
        for k, v in src.items()
        if k not in _HOST_ENV_DROP_EXACT and not k.startswith(_HOST_ENV_DROP_PREFIXES)
    }


def _agent_env(cfg: dict, type_: str) -> dict:
    """按 agent 配置生成需要注入子进程的额外环境变量（API Key 与代理）。

    - ``cfg.api_key``：非空字符串时注入该类型的 API Key 环境变量
      （规格表 ``api_key_env``，可用 ``cfg.api_key_env`` 覆盖；未知类型不注入）。
      注意 ``_clean_env`` 已剥掉宿主注入的 CODEBUDDY_/CLAUDE_ 前缀变量，
      这里注入的是用户在「Agent 管理」里显式配置的值，二者不冲突。
    - ``cfg.proxy``：非空字符串时注入 HTTP(S)_PROXY（大小写各一份，兼容不同 CLI），
      并固定 NO_PROXY 排除本机回环，避免代理劫持本地流量。

    纯函数，便于单测。
    """
    out: dict = {}
    api_key = cfg.get("api_key")
    if isinstance(api_key, str) and api_key.strip():
        env_name = cfg.get("api_key_env")
        if not (isinstance(env_name, str) and env_name.strip()):
            spec = _CLI_SPECS.get(type_) or {}
            env_name = spec.get("api_key_env")
        if isinstance(env_name, str) and env_name.strip():
            out[env_name.strip()] = api_key.strip()
    proxy = cfg.get("proxy")
    if isinstance(proxy, str) and proxy.strip():
        proxy = proxy.strip()
        out.update({
            "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy,
            "http_proxy": proxy, "https_proxy": proxy,
            "NO_PROXY": "localhost,127.0.0.1",
            "no_proxy": "localhost,127.0.0.1",
        })
    return out


def _resolve_cmd(cmd: str) -> str:
    """解析可执行文件入口。

    Windows 下 npm 全局安装的 CLI 多为 ``.cmd``/``.bat`` shim，asyncio 子进程不走
    shell、不做 PATHEXT 解析，直接用 ``codebuddy`` 会 ``WinError 2``。
    用 ``shutil.which`` 拿到真实入口（如 ``codebuddy.cmd``）；找不到时原样返回。
    """
    if os.name == "nt":
        resolved = shutil.which(cmd)
        if resolved:
            return resolved
        for ext in (".cmd", ".bat", ".exe"):
            hit = shutil.which(cmd + ext)
            if hit:
                return hit
    return cmd


def _decode(raw: bytes) -> str:
    """把子进程输出字节解码为文本。

    codebuddy CLI 在中文 Windows 上可能用 GBK(CP936) 输出系统告警（如 wmic 报错），
    也可能用 UTF-8 输出正文。直接 ``decode('utf-8')`` 会把 GBK 字节解成乱码。这里
    UTF-8 优先、GBK 兜底，二者皆败再用 replace，保证可读、不崩。
    """
    if not raw:
        return ""
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def _mojibake_ratio(text: str) -> float:
    """一行文本里 U+FFFD（替换符）的占比，用于识别已被上游解坏的乱码行。"""
    body = (text or "").strip()
    if not body:
        return 0.0
    return body.count("\ufffd") / len(body)


def is_noise_line(text: str) -> bool:
    """一行是否属于 codebuddy 启动器的良性噪声，不应进对话/日志。

    覆盖两种形态：
    - 原样 GBK（我们这边按行解码成功）：'wmic' 不是内部或外部命令…
    - 已被 CLI 二次解码成 U+FFFD 乱码的同一批行：特征是 ASCII 部分还在
      （``'wmic'`` 字样幸存），或整行乱码密度极高（如「拒绝访问。」解坏后的样子）。
      正常的模型输出与真实报错几乎不会出现连续多个 U+FFFD。
    """
    body = text or ""
    if _WMIC_NOISE_MARK in body and "wmic" in body.lower():
        return True
    if "wmic" in body.lower() and _mojibake_ratio(body) >= 0.2:
        return True
    # 与 wmic 无关但整行基本是乱码（如「拒绝访问。」被解坏）：同样按噪声丢弃
    return body.count("\ufffd") >= 3 and _mojibake_ratio(body) >= 0.3


def _emit_line(raw: bytes, level: str) -> None:
    """把一行原始字节解成文本后送进实时日志总线（归属由 logbus 上下文提供）。"""
    text = _decode(raw).rstrip()
    if not text.strip() or is_noise_line(text):
        return
    LOG.emit_current(text, level=level, source="agent")


async def _pump(stream, keep: list, level: str, emit: bool = True) -> None:
    """边读边推子进程输出：完整字节攒进 keep，遇到换行就落一条实时日志。

    按 ``\\n`` 切分是编码安全的：UTF-8 / GBK 的多字节序列里都不会出现 0x0A 字节，
    所以切点必然落在字符边界上，不会把字符劈成半个。``emit=False`` 时只攒字节
    不进日志总线 —— JSON 结果模式下 stdout 是一整段单行 JSON，逐行吐出去是噪声，
    正文会在解析成功后由 message 事件补进日志。
    """
    buf = bytearray()
    while True:
        chunk = await stream.read(_READ_CHUNK)
        if not chunk:
            break
        keep.append(chunk)
        if not emit:
            continue
        buf.extend(chunk)
        while True:
            idx = buf.find(b"\n")
            if idx < 0:
                break
            line = bytes(buf[:idx])
            del buf[:idx + 1]
            _emit_line(line, level)
        if len(buf) >= _TAIL_LIMIT:
            # 长时间不换行（或一行超长）：先落一条，既不阻塞也不让内存无上限增长
            _emit_line(bytes(buf), level)
            buf.clear()
    if buf:
        _emit_line(bytes(buf), level)


def _read_settings() -> dict:
    try:
        return json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _write_settings(d: dict) -> None:
    _SETTINGS_PATH.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def cleanup_leftover_trust() -> None:
    """清理上次崩溃遗留的探针临时目录信任项（一次性目录已被 rmtree，对应条目应移除）。"""
    with _SETTINGS_LOCK:
        d = _read_settings()
        td = d.get("trustedDirectories")
        if isinstance(td, list):
            kept = [t for t in td if _TRUST_MARKER not in t]
            if len(kept) != len(td):
                d["trustedDirectories"] = kept
                _write_settings(d)


def _add_trusted(path: str) -> None:
    norm = path.replace("\\", "/")
    with _SETTINGS_LOCK:
        d = _read_settings()
        td = d.setdefault("trustedDirectories", [])
        if norm not in td:
            td.append(norm)
            _write_settings(d)


def _remove_trusted(path: str) -> None:
    norm = path.replace("\\", "/")
    with _SETTINGS_LOCK:
        d = _read_settings()
        td = d.get("trustedDirectories")
        if isinstance(td, list) and norm in td:
            td.remove(norm)
            _write_settings(d)


def _kill(proc) -> None:
    try:
        if proc.returncode is None:
            proc.kill()
    except Exception:  # noqa: BLE001
        pass


def _taskkill_tree(pid: int) -> None:
    """Windows：按 PID 连整棵子进程树一起强杀（``/T``）。同步阻塞，调用方放线程里跑。"""
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                   capture_output=True, timeout=10)


async def _terminate(proc) -> None:
    """终止子进程及其整棵树，并等它真正退出。

    只 ``proc.kill()`` 杀不掉 ``codebuddy.cmd`` 底下的 node 进程：孤儿会继续持有
    stdout 管道与工作目录，造成临时目录删不掉、后台进程越积越多（实测一次会话能攒下
    数个 hung CLI）。这里用 ``taskkill /T`` 连树杀，并等其退出，方便随后回收目录。
    """
    if proc.returncode is not None:
        return
    try:
        if os.name == "nt":
            await asyncio.to_thread(_taskkill_tree, proc.pid)
        else:
            proc.kill()
    except Exception:  # noqa: BLE001
        _kill(proc)
    try:
        await asyncio.wait_for(proc.wait(), timeout=6)
    except (asyncio.TimeoutError, ProcessLookupError):
        _kill(proc)


# 模块加载时清理可能残留的探针信任项
cleanup_leftover_trust()


# 各 CLI 类型的基础命令行规格：base_flags 为非交互/跳过权限的固定参数，
# model_flag 为指定模型的参数名（配合 agent 配置里的 model 字段）。
# api_key_env 为 agent 配置 api_key 注入子进程时的环境变量名（可在配置里用
# api_key_env 覆盖；见 _agent_env）。
# stream_flags 非空时走「stream-json 流式」模式：stdout 是逐行 JSON 事件流，
# 模型每吐一段正文就实时产出事件，对话面板不再等整趟跑完才一次性展示；
# 结束时的 result 事件同样带真实 usage（与 --output-format json 同源），用量留痕不丢。
# 用户在 args 里自带 --output-format 时以用户为准，自动退回非流式路径。
# cmd 与 args 均可在「Agent 管理」的 config 里覆盖（cmd / args / model）。
_CLI_SPECS = {
    # codebuddy：信任门禁需临时写入 ~/.codebuddy/settings.json（见 _add_trusted）；
    # json_result 是流式不可用时的 JSON 结果模式兜底（真实 token 用量的另一来源）
    "codebuddy": {"cmd": "codebuddy", "base_flags": ("-p", "-y"),
                  "model_flag": "--model", "trust": True, "json_result": True,
                  "api_key_env": "CODEBUDDY_API_KEY",
                  "resume": {"mode": "flag", "flag": "--resume"},
                  "stream_flags": ("--output-format", "stream-json",
                                   "--include-partial-messages", "--verbose")},
    # claude：-p 非交互打印模式；--dangerously-skip-permissions 对应 -y 的跳权限语义；
    # stream-json 在 -p 模式下必须带 --verbose（否则 CLI 直接报错退出）
    "claude": {"cmd": "claude", "base_flags": ("-p", "--dangerously-skip-permissions"),
               "model_flag": "--model", "trust": False,
               "api_key_env": "ANTHROPIC_API_KEY",
               "resume": {"mode": "flag", "flag": "--resume"},
               "stream_flags": ("--output-format", "stream-json",
                                "--include-partial-messages", "--verbose")},
    # codex：exec 非交互模式；--full-auto 沙箱内自动执行；非 git 目录需 --skip-git-repo-check
    # 续聊走子命令：codex exec resume <SESSION_ID> ...（不是 --resume 参数）
    "codex": {"cmd": "codex", "base_flags": ("exec", "--full-auto", "--skip-git-repo-check"),
              "model_flag": "--model", "trust": False, "stream_flags": (),
              "resume": {"mode": "subcommand", "after": "exec", "token": "resume"},
              "api_key_env": "OPENAI_API_KEY"},
    # cursor：cursor-agent 的非交互打印模式；--trust 跳过 Workspace Trust 交互确认
    # （平台在临时目录里跑 agent，没人能在终端里答 trust 询问，不加会直接失败）；
    # json_result 开启后自动追加 --output-format json，结束时的单对象 result 带
    # 真实 usage（camelCase 键名，normalize_usage 已兼容），用量留痕不再靠估算
    "cursor": {"cmd": "cursor-agent", "base_flags": ("-p", "--trust"),
               "model_flag": "--model", "trust": False, "stream_flags": (),
               "resume": {"mode": "flag", "flag": "--resume"},
               "json_result": True, "api_key_env": "CURSOR_API_KEY"},
}

CLI_AGENT_TYPES = tuple(_CLI_SPECS)


def _wants_json_output(cfg: dict, spec: dict) -> bool:
    """是否应以 JSON 结果模式调用：规格开启了 json_result，且用户没有自带 --output-format。

    用户在 agent 配置 args 里显式给了 --output-format 时以用户为准（命令行里后出现的生效）。
    """
    if not spec.get("json_result"):
        return False
    args = cfg.get("args") or []
    return not any(str(a).startswith("--output-format") for a in args)


def _wants_stream(cfg: dict, spec: dict) -> bool:
    """是否应以 stream-json 流式模式调用：规格带 stream_flags，且用户没有自带 --output-format。

    流式优先于 json_result（result 事件同样带 usage，用量留痕不丢）；
    用户显式指定 --output-format 时以用户为准，两种模式都不启用。
    """
    if not spec.get("stream_flags"):
        return False
    args = cfg.get("args") or []
    return not any(str(a).startswith("--output-format") for a in args)


def _resume_token(resume_id) -> str:
    """把外部会话 id 归一成可安全放进命令行的字符串；无效值返回空串。"""
    return resume_id.strip() if isinstance(resume_id, str) and resume_id.strip() else ""


def _build_cli(cfg: dict, message: str, spec: dict | None = None,
               include_message: bool = True, resume_id: str | None = None) -> list:
    """按 agent 配置拼出命令行：[入口, base_flags..., (resume), (--output-format ...), (--model <model>), args..., message]。

    ``cfg.model``（可在「Agent 管理」里配置）非空字符串时追加模型参数，
    留空则用 CLI 自身默认模型；非字符串值（如误填数字）一律忽略。
    ``include_message=False`` 时不把消息追加为参数（配合 stdin 传消息，见 invoke）。
    ``resume_id`` 非空且规格支持续聊时，按 flag（``--resume <id>``）或子命令
    （``exec resume <id>``）注入，让底层 CLI 在同一会话上下文里续聊。
    """
    spec = spec or _CLI_SPECS["codebuddy"]
    cli = [_resolve_cmd(cfg.get("cmd") or spec["cmd"]), *spec["base_flags"]]
    rid = _resume_token(resume_id)
    resume_spec = spec.get("resume") if rid else None
    if resume_spec and resume_spec.get("mode") == "subcommand":
        # codex：base_flags 里的子命令（exec）之后插入 `resume <id>`
        after = resume_spec.get("after")
        tok = resume_spec.get("token", "resume")
        if after in cli:
            i = cli.index(after) + 1
            cli[i:i] = [tok, rid]
        else:
            cli += [tok, rid]
    elif resume_spec and resume_spec.get("mode") == "flag":
        cli += [resume_spec.get("flag", "--resume"), rid]
    if _wants_stream(cfg, spec):
        cli += list(spec["stream_flags"])
    elif _wants_json_output(cfg, spec):
        cli += ["--output-format", "json"]
    model = cfg.get("model")
    if isinstance(model, str) and model.strip():
        cli += [spec["model_flag"], model.strip()]
    cli += list(cfg.get("args", []))
    if include_message:
        cli.append(message)
    return cli


# ---------------- CLI JSON 结果解析（真实 token 用量的来源） ----------------
#
# ``--output-format json`` 的实测形态是**一个事件数组**（同源 CLI 字段一致）：
#   [ {"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]},
#     ...
#     {"type":"message","role":"assistant","content":[{"type":"text","text":"正文"}],
#      "usage":{"input_tokens":28361,"output_tokens":96,
#               "cache_creation_input_tokens":27849,"cache_read_input_tokens":512}} ]
# 部分版本也可能直接给单个结果对象：{"is_error":false, "result":"正文", "usage":{...}}。
# 两种形态都认：数组取**最后一条带 usage 的消息**（正文取其 text 块）。

def _num(v) -> int:
    """宽松取数：非负整数才有意义，其余一律按 0 处理。"""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def normalize_usage(usage) -> dict | None:
    """把 CLI 结果里的 usage 归一成审计层认识的 prompt/completion/total 三元组。

    兼容两种键名风格：codebuddy/claude 的 snake_case（input_tokens /
    cache_read_input_tokens / cache_creation_input_tokens / output_tokens）与
    cursor 的 camelCase（inputTokens / outputTokens / cacheReadTokens /
    cacheWriteTokens）。缓存命中/写入的输入 token 也是这次调用真实消耗的输入，
    计入 prompt_tokens，否则大上下文会话的输入用量会被严重低估。
    全是 0 / 缺失时返回 None（让上层走估算）。
    """
    if not isinstance(usage, dict):
        return None

    def _pick(*keys) -> int:
        """按顺序取第一个非空键的值（snake_case 与 camelCase 同义键并存）。"""
        for k in keys:
            if k in usage:
                return _num(usage[k])
        return 0

    prompt = (_pick("input_tokens", "inputTokens")
              + _pick("cache_read_input_tokens", "cacheReadTokens")
              + _pick("cache_creation_input_tokens", "cacheWriteTokens"))
    completion = _pick("output_tokens", "outputTokens")
    total = _num(usage.get("total_tokens")) or _num(usage.get("totalTokens")) \
        or (prompt + completion)
    if not (prompt or completion or total):
        return None
    if not total:
        total = prompt + completion
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": total}


def _text_blocks(content) -> str:
    """从消息的 content 里拼出正文：text 块按序拼接；content 本身是字符串时原样返回。"""
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and isinstance(b.get("text"), str) \
                    and b.get("type") in (None, "text", "output_text"):
                parts.append(b["text"])
    return "\n".join(p for p in parts if p)


def _session_id_of(d) -> str | None:
    sid = d.get("session_id") if isinstance(d, dict) else None
    return sid.strip() if isinstance(sid, str) and sid.strip() else None


def _from_obj(d) -> dict | None:
    """单个结果对象 → {text, usage, is_error, session_id}；不是结果形态返回 None。"""
    if not isinstance(d, dict):
        return None
    if "result" in d or "is_error" in d:
        body = d.get("result")
        return {"text": body if isinstance(body, str) else (_text_blocks(d.get("content"))),
                "usage": normalize_usage(d.get("usage")),
                "is_error": bool(d.get("is_error")),
                "session_id": _session_id_of(d)}
    # 事件数组里的消息形态：带 usage 的消息也是有效结果（数组分支会优先按 usage 找）
    if "usage" in d and isinstance(d.get("usage"), dict):
        return {"text": _text_blocks(d.get("content")),
                "usage": normalize_usage(d.get("usage")),
                "is_error": bool(d.get("is_error")),
                "session_id": _session_id_of(d)}
    return None


def _from_array(items) -> dict | None:
    """事件数组 → 取最后一条带 usage 的消息作为结果；一条都没有返回 None。

    session_id 可能落在没有 usage 的 system/init 或 result 事件上，因此单独扫一遍
    整个数组补齐（结果消息本身没带时用它兜底）。
    """
    if not isinstance(items, list):
        return None
    is_error = any(isinstance(x, dict) and x.get("is_error") for x in items)
    array_sid = next((s for d in items if (s := _session_id_of(d))), None)
    for d in reversed(items):
        got = _from_obj(d)
        if got is not None and got["usage"] is not None:
            got["is_error"] = got["is_error"] or is_error
            got["session_id"] = got.get("session_id") or array_sid
            return got
    return None


def parse_result_json(raw: str) -> dict | None:
    """从 CLI 的 stdout 里解析结果 JSON（数组或单对象）；解析不出返回 None（上层回退纯文本）。

    返回 ``{"text": 正文, "usage": 归一用量或 None, "is_error": bool}``。
    容忍 stdout 里混有噪声行：先整体解析，失败再逐行找第一个能解析成结果形态的行。
    """
    text = (raw or "").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
        got = _from_array(data) if isinstance(data, list) else _from_obj(data)
        if got is not None:
            return got
    except ValueError:
        pass
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith(("{", "[")):
            continue
        try:
            data = json.loads(line)
        except ValueError:
            continue
        got = _from_array(data) if isinstance(data, list) else _from_obj(data)
        if got is not None:
            return got
    return None


# ---------------- CLI stream-json 流式解析（对话实时展示的来源） ----------------
#
# ``--output-format stream-json`` 的 stdout 是逐行 JSON 事件（codebuddy 与 claude
# 同源同协议，已对照 CLI bundle 确认），本适配器关心四种：
#   {"type":"stream_event","event":{"type":"content_block_delta",
#        "delta":{"type":"text_delta","text":"增量正文"}}}     ← 模型正在吐字
#   {"type":"assistant","message":{"content":[{...}]}}         ← 一轮消息完成
#   {"type":"result","is_error":false,"result":"最终正文",
#    "usage":{...}}                                            ← 整趟结束（含真实用量）
#   {"type":"system"|"user", ...}                              ← 忽略


class _StreamSession:
    """把 stream-json 的 JSONL 行翻译成 AgentEvent 列表（纯逻辑，可单测）。

    事件语义（与 session_service / agent_test / 前端的约定）：
    - ``delta``：增量正文，只往前端推（不落库、不进审计正文、不进探测事件表）；
    - ``message``（payload.transient）：中间轮次的完整正文（模型边想边说的过程话），
      也只实时展示，不落库 —— 落库的对话主线只保留最终答复，重放不掺过程话；
    - ``status``（payload.transient）：瞬态状态（如调用工具），只展示不落库；
    - 结束时由 result 事件产出唯一的最终 ``message``（带 usage），
      result 缺失时回退用最后一轮正文充当最终答复。
    """

    def __init__(self):
        self.turn_texts: list[str] = []      # 各轮完整正文（中间过程话）
        self.final_result: str | None = None
        self.final_usage: dict | None = None
        self.result_is_error: bool = False
        self.error_text: str | None = None
        self.session_id: str | None = None   # CLI 外部会话 id（system/init 或 result 携带）

    # -- 单行解析 --

    def handle_line(self, raw: bytes) -> list[AgentEvent]:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            return []
        try:
            data = json.loads(line)
        except ValueError:
            # stream 模式的 stdout 应当是纯 JSONL；混进来的裸文本（启动器告警等）
            # 照旧按行进实时日志（乱码噪声由 is_noise_line 拦下）
            if not is_noise_line(_decode(raw)):
                _emit_line(raw, "info")
            return []
        if not isinstance(data, dict):
            return []
        return self._handle(data)

    def _handle(self, data: dict) -> list[AgentEvent]:
        evs: list[AgentEvent] = []
        t = data.get("type")
        # 任何事件携带的 session_id 都记下来（system/init 最早给出，result 兜底）
        sid = data.get("session_id")
        if isinstance(sid, str) and sid.strip() and not self.session_id:
            self.session_id = sid.strip()
        if t == "stream_event":
            inner = data.get("event") or {}
            if inner.get("type") == "content_block_delta":
                d = inner.get("delta") or {}
                # thinking_delta 是思考摘要，先不透出（避免干扰正文阅读）
                if d.get("type") == "text_delta" and (d.get("text") or ""):
                    evs.append(AgentEvent(type="delta", pane="message", text=d["text"]))
        elif t == "assistant":
            for blk in (data.get("message") or {}).get("content") or []:
                if not isinstance(blk, dict):
                    continue
                if blk.get("type") == "text" and (blk.get("text") or "").strip():
                    txt = blk["text"]
                    self.turn_texts.append(txt)
                    evs.append(AgentEvent(type="message", pane="message", text=txt,
                                          payload={"streamed": True, "transient": True}))
                elif blk.get("type") == "tool_use":
                    name = blk.get("name") or "工具"
                    evs.append(AgentEvent(type="status", pane="message",
                                          text=f"调用工具 {name}", payload={"transient": True}))
        elif t == "result":
            self.final_usage = normalize_usage(data.get("usage"))
            if data.get("is_error"):
                self.result_is_error = True
                self.error_text = data.get("result") or "CLI 报告运行失败"
            else:
                r = data.get("result")
                if isinstance(r, str) and r.strip():
                    self.final_result = r
        return evs

    # -- 收尾 --

    def final_events(self, cli_type: str) -> list[AgentEvent]:
        """进程结束后依结果产出收尾事件：失败报 error，成功产出最终答复（带 usage）。"""
        if self.result_is_error:
            return [AgentEvent(type="error", pane="message",
                               text=f"{cli_type} 运行失败：{self.error_text or '未知原因'}")]
        if self.final_result:
            payload: dict = {"streamed": True}
            if self.final_usage:
                payload["usage"] = self.final_usage
            return [AgentEvent(type="message", pane="message",
                               text=self.final_result, payload=payload)]
        if self.turn_texts:
            # result 事件缺失（异常退出 / 版本差异）：拿最后一轮正文兜底，内容不丢
            return [AgentEvent(type="message", pane="message", text=self.turn_texts[-1],
                               payload={"streamed": True})]
        return []


class CliAgentAdapter:
    """通用 CLI 适配器：同一套子进程流程按类型套用不同命令行规格（见 _CLI_SPECS）。"""

    def __init__(self, type_: str = "codebuddy"):
        if type_ not in _CLI_SPECS:
            raise KeyError(f"未知 CLI agent 类型: {type_}")
        self.type = type_
        self.spec = _CLI_SPECS[type_]

    async def _pump_stream(self, proc, out_chunks: list, err_chunks: list,
                           state: "_StreamSession"):
        """stream-json 模式的 stdout 泵：逐行解析成事件边跑边产，原始字节照旧攒底。

        stderr 交给 `_pump` 在旁路任务里实时进日志；stdout 每读满一行就喂给
        `_StreamSession`，产出的事件立刻 yield 给上层（会话 / 探测），实现真正的
        「模型边吐字、前端边显示」。进程结束后等 stderr 泵收尾，避免尾部告警丢失。
        """
        err_task = asyncio.create_task(_pump(proc.stderr, err_chunks, "warn"))
        buf = bytearray()
        try:
            while True:
                chunk = await proc.stdout.read(_READ_CHUNK)
                if not chunk:
                    break
                out_chunks.append(chunk)
                buf.extend(chunk)
                while True:
                    idx = buf.find(b"\n")
                    if idx < 0:
                        break
                    line = bytes(buf[:idx])
                    del buf[: idx + 1]
                    for ev in state.handle_line(line):
                        yield ev
            if buf:
                for ev in state.handle_line(bytes(buf)):
                    yield ev
            await proc.wait()
        finally:
            if not err_task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(err_task), timeout=5)
                except Exception:  # noqa: BLE001 - 收尾失败不影响主流程
                    err_task.cancel()

    async def invoke(self, agent_row, message, project_path, resume_id=None):
        cfg = json.loads(agent_row["config"]) if isinstance(agent_row, dict) else {}
        cmd = cfg.get("cmd") or self.spec["cmd"]
        # Windows 上 CLI 经 cmd.exe 启动 .cmd 垫片，多行命令行参数会在第一个换行处
        # 被 cmd 截断（实测：后面的内容整体丢失）。聊天消息前会注入多行的路径约定，
        # 因此含换行的消息一律改走 stdin 传给 CLI（CLI 非交互模式支持从 stdin 读提示词），
        # 单行消息仍走命令行参数，行为不变。
        multiline = "\n" in message
        # 基础参数 + 可选续聊参数 + 可选模型参数 + 自定义 args；信任目录仅 codebuddy 需要临时注入（见下方 finally）
        cli = _build_cli(cfg, message, self.spec, include_message=not multiline,
                         resume_id=resume_id)
        # 流式模式：stdout 是逐行 JSON 事件流，边跑边产出事件（对话实时展示的来源）
        stream_mode = _wants_stream(cfg, self.spec)
        # JSON 结果模式：stdout 是单个结果 JSON（内含真实 usage），不逐行进实时日志
        json_mode = (not stream_mode) and _wants_json_output(cfg, self.spec)

        trusted = self.spec["trust"]
        if trusted:
            _add_trusted(project_path)
        try:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cli,
                    cwd=project_path,
                    env={**_clean_env(), **_agent_env(cfg, self.type)},
                    stdin=asyncio.subprocess.PIPE if multiline
                    else asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            except (FileNotFoundError, NotADirectoryError, PermissionError, OSError) as e:
                yield AgentEvent(
                    type="error", pane="message",
                    text=f"启动 {self.type} CLI 失败: {cmd}（{e}）。请在 agent 配置中设置正确的 cmd"
                         f"（Windows 下需指向对应 .cmd，或确保该 CLI 在 PATH 中）",
                )
                return

            feed_task: asyncio.Task | None = None
            if multiline:
                async def _feed_stdin() -> None:
                    # 写完立即关 stdin（EOF），CLI 才会开始处理；CLI 若提前退出，
                    # 写入会抛 BrokenPipeError/ConnectionResetError，静默忽略即可
                    try:
                        proc.stdin.write(message.encode("utf-8"))
                        await proc.stdin.drain()
                    except (ConnectionResetError, BrokenPipeError, RuntimeError):
                        pass
                    finally:
                        with contextlib.suppress(Exception):
                            proc.stdin.close()
                feed_task = asyncio.create_task(_feed_stdin())

            out_chunks: list = []
            err_chunks: list = []
            state: _StreamSession | None = None
            try:
                if stream_mode:
                    state = _StreamSession()
                    async for ev in self._pump_stream(proc, out_chunks, err_chunks, state):
                        yield ev
                else:
                    # 并发读两条管道：只读一条会因另一条管道写满而互相死锁
                    await asyncio.gather(
                        _pump(proc.stdout, out_chunks, "info", emit=not json_mode),
                        _pump(proc.stderr, err_chunks, "warn"),
                    )
                    await proc.wait()
            except asyncio.CancelledError:
                if feed_task is not None:
                    feed_task.cancel()
                await _terminate(proc)
                raise
            finally:
                # 收尾兜底：等喂入任务结束（正常时早已完成），并确保 stdin 已关闭
                if feed_task is not None:
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await asyncio.wait_for(feed_task, timeout=5)
                    with contextlib.suppress(Exception):
                        proc.stdin.close()
        finally:
            if trusted:
                _remove_trusted(project_path)

        out = b"".join(out_chunks)
        err = b"".join(err_chunks)
        stdout = _decode(out).strip()
        stderr = _decode(err).strip()

        if stream_mode and state is not None:
            # 捕获到底层 CLI 外部会话 id：产出 session 事件，由 session_service 落库供续聊
            if state.session_id:
                yield AgentEvent(type="session", pane="message",
                                 payload={"cli_session_id": state.session_id})
            # stderr 噪声过滤后作为 info 事件透出（与文本模式一致），不阻断主流程
            info_lines = [ln for ln in stderr.splitlines() if not is_noise_line(ln)]
            info_text = "\n".join(info_lines).strip()
            if info_text:
                yield AgentEvent(type="info", pane="message", text=info_text,
                                 payload={"streamed": True})
            finals = state.final_events(self.type)
            for ev in finals:
                yield ev
            if not finals:
                if proc.returncode != 0:
                    detail = stderr or f"退出码 {proc.returncode}"
                    yield AgentEvent(type="error", pane="message",
                                     text=f"{self.type} 调用失败：{detail}")
                else:
                    yield AgentEvent(type="error", pane="message",
                                     text=f"{self.type} 未返回任何输出（可能未通过认证或模型当前不可用）")
            return

        # 非 0 退出且无 stdout：以 stderr 作为诊断信息
        if proc.returncode != 0 and not stdout:
            detail = stderr or f"退出码 {proc.returncode}"
            yield AgentEvent(type="error", pane="message",
                             text=f"{self.type} 调用失败：{detail}")
            return

        # stderr 作为 info 事件透出（如限流告警），不阻断主流程。
        # 剥掉 codebuddy 启动器自身的良性噪声（见 is_noise_line 注释）。
        info_lines = [ln for ln in stderr.splitlines() if not is_noise_line(ln)]
        info_text = "\n".join(info_lines).strip()

        if json_mode and stdout:
            parsed = parse_result_json(stdout)
            if parsed is not None:
                if parsed.get("session_id"):
                    yield AgentEvent(type="session", pane="message",
                                     payload={"cli_session_id": parsed["session_id"]})
                if info_text:
                    yield AgentEvent(type="info", pane="message", text=info_text,
                                     payload={"streamed": True})
                usage = parsed["usage"] or {}
                if parsed["is_error"] and not parsed["text"].strip():
                    yield AgentEvent(type="error", pane="message",
                                     text=info_text or f"{self.type} 报告调用失败（未给出正文）")
                    return
                # usage 放进 payload，由 agent_test / session_service 透传给审计留痕
                yield AgentEvent(type="message", pane="message",
                                 text=parsed["text"],
                                 payload={"usage": usage} if usage else None)
                return
            # 解析失败（CLI 版本差异 / 输出格式有变）：回退纯文本路径 ——
            # 正文仍由下面的 message 事件整段产出，行为与旧版一致，内容不丢。

        if info_text:
            # payload.streamed 告诉上层「这些行已经逐行实时推送过了」，避免再重复记一遍日志
            yield AgentEvent(type="info", pane="message", text=info_text,
                             payload={"streamed": True})

        if stdout:
            yield AgentEvent(type="message", pane="message", text=stdout)
        else:
            yield AgentEvent(type="error", pane="message",
                             text=f"{self.type} 未返回任何输出（可能未通过认证或模型当前不可用）")


# 兼容旧引用：codebuddy 是本适配器的默认类型，原有测试/注册代码可直接继续用
CodeBuddyAdapter = CliAgentAdapter
