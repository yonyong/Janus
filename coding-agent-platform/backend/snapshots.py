"""工作区快照与改动回退。

为什么需要它：agent 是通过子进程改盘的，平台看不见「哪一次编辑改了哪个文件」，
所以只能在**一次 agent 运行的前后各拍一张工作区快照**，比对出这次到底动了什么，
把改动前后内容一起落库，之后才能「看到修改记录」并「回退」。

为什么不依赖 git：目标项目不一定是个 git 仓库（会话创建时 `git checkout -b` 失败
就是这种情况），而改动记录属于平台的基础能力，不该因为项目没初始化 git 就用不了。
有 git 时 `diff.compute` 仍照旧给它实时 patch，两者不冲突。

边界：只为**文本文件**保存内容（二进制与超大体量文件只记指纹，能看出被改过但
不可回退），并设有文件数 / 单文件 / 总量三重上限，超限即停止并置 truncated —— 宁可
少记一些并如实标注，也不要为了完整性把内存和磁盘吃穿。
"""
import hashlib
import os

from . import files as FS

# 不进改动记录的目录：依赖、缓存、构建产物，几乎都是噪音。
# .janus 是平台自己的工作流文档目录（原始需求 / 设计文档 / 附件 / 用例清单），
# 由平台写入而非 agent 改动，不能混进改动记录污染「回退」。
IGNORE_DIRS = {
    ".janus",
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    "dist", "build", ".next", ".nuxt", ".output", "target", "out",
    ".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".tox", ".cache", "coverage", "htmlcov", ".gradle", ".mvn",
}

# 单文件上限：超过就不存内容（只记 size+mtime 指纹），避免读大文件拖垮运行
MAX_FILE_BYTES = 256 * 1024
# 一次快照最多纳管多少个文件；超出即截断
MAX_FILES = 4000
# 一次快照最多读入多少字节；超出即截断
MAX_TOTAL_BYTES = 16 * 1024 * 1024
# 展示用 diff 单文件最多保留多少行（超出折叠），防止一个巨型文件撑爆接口响应
MAX_DIFF_LINES = 400


def _iter_files(root: str):
    """深度优先遍历工作区里的文件（相对路径升序，保证两次快照顺序一致）。

    排序很关键：截断是按遍历顺序发生的，顺序稳定才能保证「前后两次快照截断在
    同一处」，否则会把未截断的文件误判成新增/删除。
    """
    stack = [""]
    while stack:
        rel_dir = stack.pop()
        abs_dir = os.path.join(root, rel_dir) if rel_dir else root
        try:
            entries = sorted(os.scandir(abs_dir), key=lambda e: e.name)
        except OSError:
            continue
        subdirs = []
        for e in entries:
            rel = f"{rel_dir}/{e.name}" if rel_dir else e.name
            try:
                if e.is_dir(follow_symlinks=False):
                    if e.name in IGNORE_DIRS or e.name.startswith(".git"):
                        continue
                    subdirs.append(rel)
                elif e.is_file(follow_symlinks=False):
                    yield rel, os.path.join(abs_dir, e.name)
            except OSError:
                continue
        # 栈是后进先出，倒着压入才是升序
        for d in reversed(subdirs):
            stack.append(d)


def _fingerprint(rel: str, ap: str):
    """返回单个文件的快照项；读取失败时返回 None（当作不存在）。"""
    try:
        st = os.stat(ap)
    except OSError:
        return None
    size = st.st_size
    if size > MAX_FILE_BYTES:
        # 过大：不读内容，用 size+mtime 当指纹（够判断「有没有被改」）
        return {"content": None, "binary": True, "size": size,
                "digest": f"{size}:{int(st.st_mtime)}", "oversize": True}
    try:
        with open(ap, "rb") as f:
            data = f.read(MAX_FILE_BYTES)
    except OSError:
        return None
    if b"\x00" in data[:4096]:
        return {"content": None, "binary": True, "size": size,
                "digest": hashlib.md5(data).hexdigest(), "oversize": False}
    return {"content": data.decode("utf-8", errors="replace"), "binary": False,
            "size": size, "digest": hashlib.md5(data).hexdigest(), "oversize": False}


def capture(root: str, max_files: int = MAX_FILES, max_bytes: int = MAX_TOTAL_BYTES):
    """给工作区拍一张快照。

    返回 (files, truncated)：files 为 {相对路径: 快照项}，truncated 表示因上限提前收手
    （此时记录可能不完整，调用方应如实告知用户）。
    """
    base = FS.ensure_root(root)
    out: dict = {}
    truncated = False
    total = 0
    for rel, ap in _iter_files(base):
        if len(out) >= max_files or total >= max_bytes:
            truncated = True
            break
        item = _fingerprint(rel, ap)
        if item is None:
            continue
        out[rel] = item
        if item["content"] is not None:
            total += len(item["content"].encode("utf-8", errors="replace"))
    return out, truncated


def _same(a: dict, b: dict) -> bool:
    if a["binary"] or b["binary"]:
        return a["digest"] == b["digest"]
    return a["content"] == b["content"]


def diff_snapshots(before: dict, after: dict):
    """比对两次快照，产出文件级改动列表。

    status：added（新增）/ modified（修改）/ removed（删除）。
    before / after 为该侧的文本内容，二进制与超限文件为 None。
    """
    out = []
    for rel in sorted(set(before) | set(after)):
        b = before.get(rel)
        a = after.get(rel)
        if b is None:
            out.append({"path": rel, "status": "added", "before": None,
                        "after": a["content"], "binary": a["binary"]})
        elif a is None:
            out.append({"path": rel, "status": "removed", "before": b["content"],
                        "after": None, "binary": b["binary"]})
        elif not _same(b, a):
            out.append({"path": rel, "status": "modified", "before": b["content"],
                        "after": a["content"], "binary": a["binary"] or b["binary"]})
    return out


def unified(before: str | None, after: str | None, path: str,
            max_lines: int = MAX_DIFF_LINES) -> str:
    """把改动渲染成统一的 diff 文本（前端直接给 <pre> 用，不在浏览器里算）。"""
    import difflib
    b = (before if before is not None else "").splitlines(keepends=True)
    a = (after if after is not None else "").splitlines(keepends=True)
    lines = list(difflib.unified_diff(
        b, a, fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="\n"))
    if len(lines) > max_lines:
        head = lines[:max_lines]
        head.append(f"... 改动过大，仅显示前 {max_lines} 行（共 {len(lines)} 行）\n")
        return "".join(head)
    return "".join(lines)


def apply_revert(root: str, entries) -> list[dict]:
    """把若干文件恢复成改动前的内容。

    entries 里每项需要 path 与 before：
    before 为 None 表示该文件是这次改动**新增**的，回退即删除；
    否则把 before 的内容写回（文件已被删掉的则重新创建）。
    二进制 / 超限文件没有内容可写，跳过并如实回报，不静默假装成功。
    """
    base = FS.ensure_root(root)
    results = []
    for e in entries:
        rel = e["path"]
        try:
            target = FS.abs_path(base, rel)
            if e.get("binary"):
                results.append({"path": rel, "ok": False,
                                "error": "二进制或超大文件未保存内容，无法回退"})
                continue
            if e["before"] is None:
                if os.path.isfile(target):
                    os.remove(target)
                    results.append({"path": rel, "ok": True, "action": "removed"})
                else:
                    results.append({"path": rel, "ok": True, "action": "absent"})
                continue
            parent = os.path.dirname(target)
            if parent and not os.path.isdir(parent):
                os.makedirs(parent, exist_ok=True)
            with open(target, "w", encoding="utf-8", newline="") as f:
                f.write(e["before"])
            results.append({"path": rel, "ok": True, "action": "restored"})
        except Exception as ex:  # noqa: BLE001 - 单个文件失败不该中断整批回退
            results.append({"path": rel, "ok": False, "error": str(ex)})
    return results
