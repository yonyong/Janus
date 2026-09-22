"""项目磁盘日志目录：列文件、按偏移读增量、供 SSE 轮询。

安全边界与 files.py 一致：相对路径规范化 + realpath 前缀校验，
禁止逃出项目 disk_path，也禁止逃出已配置的 log_dir。
"""
from __future__ import annotations

import os
import time
from typing import Any

from . import files as FS

# 单次 content 读取上限
MAX_CHUNK = 64 * 1024
# 首屏从文件尾部回看的最大字节
DEFAULT_TAIL = 64 * 1024
# 视为「日志文件」的扩展名；无扩展名的常规文件也允许（排除明显二进制）
LOG_EXTS = {".log", ".txt", ".out", ".err"}
BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
    ".pyc", ".pyo", ".class", ".o", ".a", ".wasm",
    ".woff", ".woff2", ".ttf", ".eot",
    ".mp3", ".mp4", ".avi", ".mov", ".webm",
}


class ProjectLogError(Exception):
    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code


def normalize_log_dir(disk_path: str, log_dir: str | None) -> str | None:
    """校验并规范化 log_dir（相对 disk_path）。空 → None；非法抛 ProjectLogError。"""
    raw = (log_dir or "").strip().replace("\\", "/")
    if not raw:
        return None
    try:
        rel = FS.norm_rel(raw)
    except FS.FsError as e:
        raise ProjectLogError(e.message, code=e.code) from e
    if not rel:
        return None
    try:
        root = FS.ensure_root(disk_path)
        abs_dir = FS.abs_path(root, rel)
    except FS.FsError as e:
        raise ProjectLogError(e.message, code=e.code) from e
    if not os.path.isdir(abs_dir):
        raise ProjectLogError(f"日志目录不存在或不是目录: {rel}", code=400)
    # 存 POSIX 风格相对路径
    return rel.replace("\\", "/")


def resolve_log_root(disk_path: str, log_dir: str | None) -> str | None:
    """返回日志目录绝对路径；未配置返回 None。"""
    rel = (log_dir or "").strip()
    if not rel:
        return None
    try:
        root = FS.ensure_root(disk_path)
        abs_dir = FS.abs_path(root, FS.norm_rel(rel))
    except FS.FsError as e:
        raise ProjectLogError(e.message, code=e.code) from e
    if not os.path.isdir(abs_dir):
        raise ProjectLogError("已配置的日志目录不存在", code=404)
    return abs_dir


def _is_log_candidate(name: str) -> bool:
    if not name or name.startswith("."):
        return False
    _, ext = os.path.splitext(name)
    low = ext.lower()
    if low in BINARY_EXTS:
        return False
    if low in LOG_EXTS or low == "":
        return True
    # 其它文本向扩展名也放行（.jsonl 等）
    if low in {".jsonl", ".csv", ".md"}:
        return True
    return False


def list_log_files(log_root: str) -> list[dict[str, Any]]:
    """列出日志目录下一层候选文件（不递归）。"""
    entries: list[dict[str, Any]] = []
    try:
        names = os.listdir(log_root)
    except OSError as e:
        raise ProjectLogError(f"无法读取日志目录: {e}", code=500) from e
    for name in names:
        if not _is_log_candidate(name):
            continue
        full = os.path.join(log_root, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if not os.path.isfile(full):
            continue
        entries.append({
            "path": name,
            "name": name,
            "size": int(st.st_size),
            "mtime": float(st.st_mtime),
        })
    entries.sort(key=lambda e: e["mtime"], reverse=True)
    return entries


def _file_abs(log_root: str, rel_path: str) -> str:
    try:
        rel = FS.norm_rel(rel_path)
    except FS.FsError as e:
        raise ProjectLogError(e.message, code=e.code) from e
    if not rel:
        raise ProjectLogError("请指定日志文件路径", code=400)
    try:
        return FS.abs_path(log_root, rel)
    except FS.FsError as e:
        raise ProjectLogError(e.message, code=e.code) from e


def read_log_chunk(
    log_root: str,
    rel_path: str,
    offset: int | None = None,
    *,
    max_bytes: int = MAX_CHUNK,
    tail: bool = False,
    tail_bytes: int = DEFAULT_TAIL,
) -> dict[str, Any]:
    """按字节偏移读取日志增量。

    - offset is None 且 tail=True：从文件尾部回看 tail_bytes，返回起始 offset。
    - offset >= 0：从该偏移读最多 max_bytes。
    - 文件变短（轮转）：返回 reset=True，建议客户端清空后重拉。
    """
    abs_file = _file_abs(log_root, rel_path)
    if not os.path.isfile(abs_file):
        raise ProjectLogError("日志文件不存在", code=404)
    try:
        size = os.path.getsize(abs_file)
    except OSError as e:
        raise ProjectLogError(f"无法读取日志文件: {e}", code=500) from e

    max_bytes = max(1, min(int(max_bytes or MAX_CHUNK), MAX_CHUNK * 4))

    if offset is None or tail:
        start = max(0, size - max(1, int(tail_bytes or DEFAULT_TAIL)))
    else:
        start = int(offset)
        if start < 0:
            raise ProjectLogError("offset 不能为负数", code=400)
        if start > size:
            # 文件被截断/轮转
            return {
                "path": FS.norm_rel(rel_path),
                "offset": start,
                "next_offset": 0,
                "size": size,
                "content": "",
                "eof": True,
                "reset": True,
            }

    try:
        with open(abs_file, "rb") as f:
            f.seek(start)
            raw = f.read(max_bytes)
    except OSError as e:
        raise ProjectLogError(f"无法读取日志文件: {e}", code=500) from e

    # 尽量按 utf-8 解码；尾部残缺字节丢掉（下次从 next_offset 继续）
    text = raw.decode("utf-8", errors="replace")
    next_off = start + len(raw)
    return {
        "path": FS.norm_rel(rel_path),
        "offset": start,
        "next_offset": next_off,
        "size": size,
        "content": text,
        "eof": next_off >= size,
        "reset": False,
        "mtime": time.time(),
    }
