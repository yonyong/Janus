"""需求级通用脚本：.janus/{dir}/script/ 下的可参数化脚本。

与 usecase/accept.*（总验收脚本）分离。正文可带 YAML frontmatter 声明 params；
执行时去掉 frontmatter 写入临时文件，以 CLI ``--name value`` 传参，并把结果记入
同目录 ``.runs/{stem}.json``（含 last_params）。

输出约定见 ``script_proc``：父子 UTF-8 一致采集 stdout/stderr，并注入
``JANUS_SCRIPT_LOG`` 作为可选日志副通道。
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import time
from datetime import datetime

import yaml

from . import docs as WD
from . import files as FS
from . import script_proc as SP

_INTERPRETERS = {
    ".py": ["python3"],
    ".sh": ["bash"],
    ".mjs": ["node"],
    ".js": ["node"],
}
_ALLOWED_EXT = set(_INTERPRETERS)
_OUTPUT_LIMIT = 20_000
_RUN_TIMEOUT = 600
_MAX_RUNS = 20
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
_FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


class ScriptError(Exception):
    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code


def safe_name(name: str) -> str:
    """校验脚本文件名：仅 basename + 白名单扩展名。"""
    raw = (name or "").strip().replace("\\", "/")
    if not raw or "/" in raw or raw in (".", "..") or raw.startswith("."):
        raise ScriptError("脚本名非法")
    base = os.path.basename(raw)
    if base != raw or not _NAME_RE.match(base):
        raise ScriptError("脚本名非法")
    ext = os.path.splitext(base)[1].lower()
    if ext not in _ALLOWED_EXT:
        raise ScriptError(f"不支持的脚本类型: {ext or '(无扩展名)'}")
    return base


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """拆出 YAML frontmatter 与正文。无 frontmatter 时 meta 为空 dict。"""
    raw = text if isinstance(text, str) else ""
    m = _FM_RE.match(raw)
    if not m:
        return {}, raw
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError as e:
        raise ScriptError(f"frontmatter 无法解析: {e}") from e
    if not isinstance(meta, dict):
        raise ScriptError("frontmatter 必须是 YAML 对象")
    body = raw[m.end():]
    return meta, body


_SELECT_TYPES = {"select", "enum", "choice", "option"}


def _normalize_options(raw) -> list[dict]:
    """把 options/choices 收成 ``[{value, label}]``。支持字符串列表或 ``{value, label}``。"""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        value = ""
        label = ""
        if isinstance(item, str):
            value = item.strip()
            label = value
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            value = str(item)
            label = value
        elif isinstance(item, dict):
            raw_val = item.get("value")
            if raw_val is None:
                raw_val = item.get("label")
            value = "" if raw_val is None else str(raw_val).strip()
            label = str(item.get("label") or value).strip() or value
        if not value or value in seen:
            continue
        seen.add(value)
        out.append({"value": value, "label": label})
    return out


def _normalize_params(meta: dict) -> list[dict]:
    raw = meta.get("params") or []
    if not isinstance(raw, list):
        return []
    out = []
    for p in raw:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        name = str(p["name"]).strip()
        if not name:
            continue
        typ = str(p.get("type") or "string").lower()
        options = _normalize_options(
            p.get("options") if p.get("options") is not None else p.get("choices")
        )
        # 声明了可选项，或 type 为 select/enum：填写时只能从选项里选。
        if typ in _SELECT_TYPES or (typ == "string" and options):
            typ = "select" if options else "string"
        elif typ not in ("string", "number", "boolean", "select"):
            typ = "string"
        if typ == "select" and not options:
            typ = "string"
        entry = {
            "name": name,
            "label": str(p.get("label") or name),
            "type": typ,
            "default": p.get("default"),
            "required": bool(p.get("required", False)),
        }
        if typ == "select":
            entry["options"] = options
            if entry["default"] is not None:
                entry["default"] = str(entry["default"])
        out.append(entry)
    return out


def _meta_view(meta: dict, filename: str) -> dict:
    stem = os.path.splitext(filename)[0]
    display = (meta.get("name") or "").strip() or stem
    return {
        "name": filename,
        "display_name": display,
        "desc": str(meta.get("desc") or "").strip(),
        "params": _normalize_params(meta),
        "lang": (_INTERPRETERS.get(os.path.splitext(filename)[1].lower(), ["shell"]) or ["shell"])[0],
    }


def _load_runs(root: str, dir_name: str, filename: str) -> dict:
    stem = os.path.splitext(filename)[0]
    rel = WD.script_runs_file(dir_name, stem)
    try:
        ap = FS.abs_path(FS.ensure_root(root), rel)
    except FS.FsError:
        return {"last_params": {}, "runs": []}
    if not os.path.isfile(ap):
        return {"last_params": {}, "runs": []}
    try:
        data = json.loads(_read_text(ap))
    except (OSError, json.JSONDecodeError):
        return {"last_params": {}, "runs": []}
    if not isinstance(data, dict):
        return {"last_params": {}, "runs": []}
    return {
        "last_params": data.get("last_params") if isinstance(data.get("last_params"), dict) else {},
        "runs": data.get("runs") if isinstance(data.get("runs"), list) else [],
    }


def _read_text(ap: str) -> str:
    with open(ap, "r", encoding="utf-8") as f:
        return f.read()


def _save_runs(root: str, dir_name: str, filename: str, data: dict) -> None:
    stem = os.path.splitext(filename)[0]
    rel = WD.script_runs_file(dir_name, stem)
    base = FS.ensure_root(root)
    ap = FS.abs_path(base, rel)
    os.makedirs(os.path.dirname(ap), exist_ok=True)
    with open(ap, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def list_scripts(root: str, dir_name: str) -> list[dict]:
    if not (dir_name or "").strip():
        return []
    try:
        base = FS.ensure_root(root)
        ap = FS.abs_path(base, WD.script_dir(dir_name))
    except FS.FsError:
        return []
    if not os.path.isdir(ap):
        return []
    items = []
    for name in sorted(os.listdir(ap)):
        if name.startswith("."):
            continue
        full = os.path.join(ap, name)
        if not os.path.isfile(full):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in _ALLOWED_EXT:
            continue
        try:
            text = _read_text(full)
            meta, _ = parse_frontmatter(text)
        except (OSError, ScriptError):
            meta = {}
        view = _meta_view(meta, name)
        st = os.stat(full)
        view["mtime"] = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(st.st_mtime))
        view["path"] = WD.script_file(dir_name, name)
        runs = _load_runs(root, dir_name, name)
        view["last_params"] = runs.get("last_params") or {}
        view["run_count"] = len(runs.get("runs") or [])
        items.append(view)
    return items


def read_script(root: str, dir_name: str, name: str) -> dict:
    name = safe_name(name)
    if not (dir_name or "").strip():
        raise ScriptError("需求目录未配置", code=400)
    try:
        base = FS.ensure_root(root)
        ap = FS.abs_path(base, WD.script_file(dir_name, name))
    except FS.FsError as e:
        raise ScriptError(e.message, code=e.code) from e
    if not os.path.isfile(ap):
        raise ScriptError("脚本不存在", code=404)
    text = _read_text(ap)
    meta, body = parse_frontmatter(text)
    view = _meta_view(meta, name)
    st = os.stat(ap)
    view["mtime"] = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(st.st_mtime))
    view["path"] = WD.script_file(dir_name, name)
    view["content"] = text
    view["body"] = body
    runs = _load_runs(root, dir_name, name)
    view["last_params"] = runs.get("last_params") or {}
    view["run_count"] = len(runs.get("runs") or [])
    return view


def write_script(root: str, dir_name: str, name: str, content: str) -> dict:
    name = safe_name(name)
    if not (dir_name or "").strip():
        raise ScriptError("需求目录未配置", code=400)
    # 校验 frontmatter（非法则拒绝保存）
    parse_frontmatter(content or "")
    try:
        base = FS.ensure_root(root)
        ap = FS.abs_path(base, WD.script_file(dir_name, name))
    except FS.FsError as e:
        raise ScriptError(e.message, code=e.code) from e
    os.makedirs(os.path.dirname(ap), exist_ok=True)
    with open(ap, "w", encoding="utf-8") as f:
        f.write(content if content is not None else "")
    return read_script(root, dir_name, name)


def delete_script(root: str, dir_name: str, name: str) -> None:
    name = safe_name(name)
    if not (dir_name or "").strip():
        raise ScriptError("需求目录未配置", code=400)
    try:
        base = FS.ensure_root(root)
        ap = FS.abs_path(base, WD.script_file(dir_name, name))
        runs_ap = FS.abs_path(base, WD.script_runs_file(dir_name, os.path.splitext(name)[0]))
    except FS.FsError as e:
        raise ScriptError(e.message, code=e.code) from e
    if os.path.isfile(ap):
        os.remove(ap)
    if os.path.isfile(runs_ap):
        os.remove(runs_ap)


def _cli_args(params_schema: list[dict], params: dict) -> list[str]:
    """按 schema 组装 ``--name value``；缺省非必填可省略。"""
    args: list[str] = []
    raw = params or {}
    for p in params_schema:
        key = p["name"]
        if key in raw and raw[key] is not None and raw[key] != "":
            val = raw[key]
        elif p.get("default") is not None:
            val = p["default"]
        elif p.get("required"):
            raise ScriptError(f"缺少必填参数: {key}")
        else:
            continue
        if p["type"] == "boolean":
            if isinstance(val, bool):
                sval = "true" if val else "false"
            else:
                sval = "true" if str(val).strip().lower() in ("1", "true", "yes", "on") else "false"
        elif p["type"] == "number":
            sval = str(val)
        elif p["type"] == "select":
            sval = str(val)
            allowed = [o["value"] for o in (p.get("options") or [])]
            if allowed and sval not in allowed:
                raise ScriptError(f"参数 {key} 只能选择: {' / '.join(allowed)}")
        else:
            sval = str(val)
        args.extend([f"--{key}", sval])
    return args


def run_script(root: str, dir_name: str, name: str, params: dict | None = None,
               timeout: int = _RUN_TIMEOUT) -> dict:
    name = safe_name(name)
    info = read_script(root, dir_name, name)
    meta, body = parse_frontmatter(info["content"])
    schema = _normalize_params(meta)
    try:
        cli = _cli_args(schema, params or {})
    except ScriptError:
        raise
    # 实际传给记录的参数：合并 default
    effective: dict = {}
    raw = params or {}
    for p in schema:
        key = p["name"]
        if key in raw and raw[key] is not None and raw[key] != "":
            effective[key] = raw[key]
        elif p.get("default") is not None:
            effective[key] = p["default"]
    # normalize boolean/number to strings for last_params
    last_params = {k: ("true" if v is True else "false" if v is False else str(v))
                   for k, v in effective.items()}

    try:
        base = FS.ensure_root(root)
    except FS.FsError:
        return {"ran": False, "reason": "bad_root"}

    ext = os.path.splitext(name)[1].lower()
    interp = _INTERPRETERS.get(ext)
    if not interp:
        return {"ran": False, "reason": "unsupported_ext"}

    # 与审计 / Agent 调用留痕一致：存本地时间，日志页直接展示、无需前端再换算
    started = datetime.now()
    run_id = started.strftime("%Y%m%dT%H%M%S")
    t0 = time.monotonic()
    tmp_path = None
    try:
        suffix = ext or ".py"
        fd, tmp_path = tempfile.mkstemp(prefix="janus-script-", suffix=suffix, dir=base)
        os.close(fd)
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(body if body is not None else "")
        # .sh 需要可执行位时仍用 bash 解释器，不必 chmod
        cmd = interp + [tmp_path] + cli
        try:
            captured = SP.run_captured(cmd, cwd=base, timeout=timeout)
        except FileNotFoundError as e:
            return {"ran": False, "reason": "interpreter_missing", "detail": str(e),
                    "entry": name, "lang": info["lang"]}
        except OSError as e:  # noqa: BLE001
            return {"ran": False, "reason": "os_error", "detail": str(e), "entry": name}
        if captured.get("timed_out"):
            return {
                "ran": False,
                "reason": "timeout",
                "entry": name,
                "timeout": timeout,
                "output": captured.get("output") or "",
            }
        out = captured.get("output") or ""
        truncated = len(out) > _OUTPUT_LIMIT
        if truncated:
            out = out[:_OUTPUT_LIMIT] + "\n…（输出已截断）"
        duration_ms = int((time.monotonic() - t0) * 1000)
        exit_code = int(captured.get("returncode") or 0)
        record = {
            "id": run_id,
            "started_at": started.strftime("%Y-%m-%d %H:%M:%S"),
            "exit_code": exit_code,
            "params": last_params,
            "output": out,
            "duration_ms": duration_ms,
            "truncated": truncated,
        }
        store = _load_runs(root, dir_name, name)
        store["last_params"] = last_params
        runs = [record] + list(store.get("runs") or [])
        store["runs"] = runs[:_MAX_RUNS]
        _save_runs(root, dir_name, name, store)
        return {
            "ran": True,
            "exit_code": exit_code,
            "output": out,
            "entry": name,
            "truncated": truncated,
            "duration_ms": duration_ms,
            "run": record,
            "last_params": last_params,
        }
    finally:
        if tmp_path and os.path.isfile(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def list_runs(root: str, dir_name: str, name: str) -> list[dict]:
    name = safe_name(name)
    # 确认脚本存在
    read_script(root, dir_name, name)
    return list((_load_runs(root, dir_name, name).get("runs") or []))
