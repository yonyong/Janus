"""通用「总验收脚本」的发现与执行。

原则：用例是账本，脚本是跑法。日常验收只跑 ``.janus/{需求目录}/usecase/accept.*``，
平台不再每次让 AI 临场想测法。脚本按扩展名选解释器，在项目工作区里执行；它自己读
用例清单、跳过标「人工」的用例、按标题逐条检查，并把结果写进 ``arch/test-result.md``
（Markdown 表格），随后由 test_report.sync_cases 回写用例状态。

只发现与执行既有脚本，不生成脚本（生成是 Agent 的活，见「生成/更新验收脚本」指令）。
"""
import os
from datetime import datetime, timezone

from . import docs as WD
from . import files as FS
from . import script_proc as SP

# 入口扩展名 → 解释器。约定入口文件名 accept.*（见 docs.ACCEPT_CANDIDATES）。
_INTERPRETERS = {
    ".py": ["python3"],
    ".sh": ["bash"],
    ".mjs": ["node"],
    ".js": ["node"],
}

_OUTPUT_LIMIT = 20_000     # 脚本输出留痕上限，超出截断（避免超长日志撑爆响应）
_RUN_TIMEOUT = 600         # 单次验收执行超时（秒）


def find_script(root: str, dir_name: str) -> dict | None:
    """返回第一个存在的 accept.* 入口 {rel, abspath, name}；都不存在返回 None。"""
    if not (dir_name or "").strip():
        return None
    try:
        base = FS.ensure_root(root)
    except FS.FsError:
        return None
    for name in WD.ACCEPT_CANDIDATES:
        rel = WD.accept_script(dir_name, name)
        try:
            ap = FS.abs_path(base, rel)
        except FS.FsError:
            continue
        if os.path.isfile(ap):
            return {"rel": rel, "abspath": ap, "name": name}
    return None


def _to_epoch(ts) -> float:
    """库里的 UTC 时间串（datetime('now')）→ epoch 秒；解析不出返回 0。"""
    if not ts:
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(ts, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return 0.0


def _lang_of(name: str) -> str:
    return (_INTERPRETERS.get(os.path.splitext(name)[1], ["shell"]) or ["shell"])[0]


def script_status(cases: list[dict], root: str, dir_name: str) -> dict:
    """脚本状态：存在？路径、mtime、是否过期、入口语言。

    过期判定：任一用例的 updated_at 晚于脚本 mtime（留 2s 容差，避免导出清单与
    写脚本几乎同刻造成误判）。用例增删改都会刷新 updated_at / 触发重导出，因此
    「用例变了脚本没更新」能被这条判据抓到。
    """
    found = find_script(root, dir_name)
    if not found:
        return {"exists": False, "path": WD.accept_script(dir_name) if dir_name else "",
                "name": None, "mtime": None, "stale": False, "lang": None}
    mtime = os.path.getmtime(found["abspath"])
    latest = max((_to_epoch(c.get("updated_at")) for c in cases or []), default=0.0)
    return {
        "exists": True,
        "path": found["rel"],
        "name": found["name"],
        "mtime": datetime.utcfromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "stale": latest > mtime + 2,
        "lang": _lang_of(found["name"]),
    }


def run_script(root: str, dir_name: str, timeout: int = _RUN_TIMEOUT) -> dict:
    """在项目工作区执行总验收脚本，返回退出码与（截断后的）输出。

    不做 sync：调用方在拿到结果后读 arch/test-result.md 并回写用例状态。
    """
    found = find_script(root, dir_name)
    if not found:
        return {"ran": False, "reason": "no_script"}
    try:
        base = FS.ensure_root(root)
    except FS.FsError:
        return {"ran": False, "reason": "bad_root"}
    ext = os.path.splitext(found["name"])[1]
    interp = _INTERPRETERS.get(ext)
    cmd = (interp + [found["abspath"]]) if interp else [found["abspath"]]
    try:
        captured = SP.run_captured(cmd, cwd=base, timeout=timeout)
    except FileNotFoundError as e:
        return {"ran": False, "reason": "interpreter_missing",
                "detail": str(e), "entry": found["name"], "lang": _lang_of(found["name"])}
    except OSError as e:  # noqa: BLE001
        return {"ran": False, "reason": "os_error", "detail": str(e), "entry": found["name"]}
    if captured.get("timed_out"):
        return {
            "ran": False,
            "reason": "timeout",
            "entry": found["name"],
            "timeout": timeout,
            "output": captured.get("output") or "",
        }
    out = captured.get("output") or ""
    truncated = len(out) > _OUTPUT_LIMIT
    if truncated:
        out = out[:_OUTPUT_LIMIT] + "\n…（输出已截断）"
    return {"ran": True, "exit_code": int(captured.get("returncode") or 0), "output": out,
            "entry": found["name"], "truncated": truncated}
