"""项目工作区文件读写。

安全边界：所有路径都相对项目登记的 disk_path，落盘前用 realpath 做包含性校验，
`..`、绝对路径、以及指向项目外的符号链接一律拒绝——工作台是给业务人员用的，
不能变成任意路径读写文件的入口。

只做「一个目录的展开」这类轻量操作（不做递归扫描），因此不存在把整个仓库
一次性读进内存的路径；唯一可能吃内存的是单个大文件，用 MAX_READ 截断。
"""
import os
import shutil
import time

# 单文件读取上限：超过就只回元信息，避免把浏览器和后端一起拖垮。
MAX_READ = 512 * 1024
# 单次列目录上限：node_modules 这种目录动辄数万项，超出即截断并告知前端。
MAX_ENTRIES = 1000


class FsError(Exception):
    """文件操作失败（路径非法 / 目标状态不符）。

    code 用于映射 HTTP 状态：400 参数或状态问题、404 不存在、409 冲突。
    """

    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code


def norm_rel(rel: str | None) -> str:
    """把前端传来的相对路径规范成 a/b/c；拒绝 `..` 与绝对路径。"""
    raw = (rel or "").strip().replace("\\", "/")
    if raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"):
        raise FsError("必须是项目内的相对路径")
    parts: list[str] = []
    for seg in raw.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            raise FsError("路径不能包含 ..")
        parts.append(seg)
    return "/".join(parts)


def parent_of(rel: str) -> str:
    return rel.rsplit("/", 1)[0] if "/" in rel else ""


def join_name(rel: str, name: str) -> str:
    """在目录 rel 下拼一个子项名；name 必须是单层文件名。"""
    clean = (name or "").strip().replace("\\", "/").strip("/")
    if not clean or clean in (".", "..") or "/" in clean:
        raise FsError("名称不能为空，且不能包含 / 或 ..")
    return f"{rel}/{clean}" if rel else clean


def abs_path(root: str, rel: str) -> str:
    """把项目内相对路径解析成绝对路径，并校验没有逃出 root。"""
    target = os.path.join(root, *rel.split("/")) if rel else root
    real = os.path.realpath(target)
    base = os.path.realpath(root)
    if real != base and not real.startswith(base + os.sep):
        raise FsError("路径超出项目目录范围", code=403)
    return real


def ensure_root(root: str) -> str:
    if not root or not os.path.isdir(root):
        raise FsError(f"项目磁盘路径不存在或不是目录: {root or '(未配置)'}", code=400)
    return os.path.realpath(root)


def _entry(abs_p: str, rel: str, name: str) -> dict:
    try:
        st = os.stat(abs_p)
        size = None if os.path.isdir(abs_p) else st.st_size
        mtime = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime))
    except OSError:
        size, mtime = None, None
    is_dir = os.path.isdir(abs_p)
    return {
        "name": name,
        "path": rel,
        "type": "dir" if is_dir else "file",
        "size": size,
        "mtime": mtime,
        "ext": "" if is_dir else os.path.splitext(name)[1].lstrip(".").lower(),
    }


def list_dir(root: str, rel: str) -> dict:
    base = ensure_root(root)
    ap = abs_path(base, rel)
    if not os.path.isdir(ap):
        raise FsError(f"目录不存在: {rel or '/'}", code=404)
    entries: list[dict] = []
    truncated = False
    with os.scandir(ap) as it:
        for e in it:
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                break
            child_rel = f"{rel}/{e.name}" if rel else e.name
            entries.append(_entry(os.path.join(ap, e.name), child_rel, e.name))
    # 目录优先，其后按名称小写排序，浏览体验稳定
    entries.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
    return {
        "path": rel,
        "parent": parent_of(rel),
        "root": base,
        "entries": entries,
        "truncated": truncated,
        "limit": MAX_ENTRIES,
    }


def read_file(root: str, rel: str) -> dict:
    base = ensure_root(root)
    if not rel:
        raise FsError("请指定要读取的文件")
    ap = abs_path(base, rel)
    if os.path.isdir(ap):
        raise FsError("目标是一个目录，无法按文件读取")
    if not os.path.isfile(ap):
        raise FsError(f"文件不存在: {rel}", code=404)
    size = os.path.getsize(ap)
    if size > MAX_READ:
        return {
            "path": rel,
            "size": size,
            "truncated": True,
            "binary": False,
            "content": "",
            "message": f"文件 {size} 字节，超过 {MAX_READ} 字节上限，未加载内容",
        }
    with open(ap, "rb") as f:
        data = f.read(MAX_READ)
    binary = b"\x00" in data[:4096]
    if binary:
        return {
            "path": rel,
            "size": size,
            "truncated": False,
            "binary": True,
            "content": "",
            "message": "二进制文件，暂不支持在线预览与编辑",
        }
    return {
        "path": rel,
        "size": size,
        "truncated": False,
        "binary": False,
        "content": data.decode("utf-8", errors="replace"),
        "message": "",
    }


# 常见扩展名的 MIME 映射：预览接口按它给出 Content-Type，浏览器才能用原生能力
# 渲染 PDF / 图片，前端预览库也按二进制类型解析表格与文档。
MIME_BY_EXT = {
    "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "ppt": "application/vnd.ms-powerpoint",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "ico": "image/x-icon",
    "bmp": "image/bmp",
    "html": "text/html",
    "htm": "text/html",
    "css": "text/css",
    "js": "text/javascript",
    "json": "application/json",
    "xml": "application/xml",
    "txt": "text/plain",
    "csv": "text/csv",
    "md": "text/markdown",
    "zip": "application/zip",
}

# raw 预览上限：预览不是下载通道，超大文件请到项目工作区本地查看。
MAX_RAW = 64 * 1024 * 1024


def raw_meta(root: str, rel: str) -> dict:
    """原始字节流预览的元信息（绝对路径 + MIME）；路径校验与 read_file 完全一致。"""
    base = ensure_root(root)
    if not rel:
        raise FsError("请指定要预览的文件")
    ap = abs_path(base, rel)
    if os.path.isdir(ap):
        raise FsError("目标是一个目录，无法预览")
    if not os.path.isfile(ap):
        raise FsError(f"文件不存在: {rel}", code=404)
    size = os.path.getsize(ap)
    if size > MAX_RAW:
        raise FsError(f"文件 {size} 字节，超过预览上限 {MAX_RAW} 字节", code=400)
    ext = os.path.splitext(rel)[1].lstrip(".").lower()
    return {
        "path": rel,
        "abs_path": ap,
        "size": size,
        "ext": ext,
        "media_type": MIME_BY_EXT.get(ext, "application/octet-stream"),
    }


def write_file(root: str, rel: str, content: str) -> dict:
    base = ensure_root(root)
    if not rel:
        raise FsError("请指定要写入的文件")
    ap = abs_path(base, rel)
    if os.path.isdir(ap):
        raise FsError("目标是一个目录，无法写入文件")
    parent = os.path.dirname(ap)
    if not os.path.isdir(parent):
        raise FsError(f"上级目录不存在: {parent_of(rel) or '/'}", code=404)
    existed = os.path.isfile(ap)
    try:
        with open(ap, "w", encoding="utf-8", newline="") as f:
            f.write(content)
    except OSError as e:
        raise FsError(f"写入失败: {e}")
    return {
        "ok": True,
        "path": rel,
        "created": not existed,
        "size": os.path.getsize(ap),
    }


def create_entry(root: str, rel: str, kind: str) -> dict:
    base = ensure_root(root)
    if not rel:
        raise FsError("请指定要创建的名称")
    ap = abs_path(base, rel)
    if os.path.exists(ap):
        raise FsError(f"已存在同名文件或目录: {rel}", code=409)
    parent = os.path.dirname(ap)
    if not os.path.isdir(parent):
        raise FsError(f"上级目录不存在: {parent_of(rel) or '/'}", code=404)
    try:
        if kind == "dir":
            os.makedirs(ap, exist_ok=False)
        else:
            with open(ap, "x", encoding="utf-8"):
                pass
    except FileExistsError:
        raise FsError(f"已存在同名文件或目录: {rel}", code=409)
    except OSError as e:
        raise FsError(f"创建失败: {e}")
    return _entry(ap, rel, os.path.basename(ap))


def rename_entry(root: str, rel: str, new_name: str) -> dict:
    """同级重命名；只允许改最后一层名字，避免跨目录移动带来的边界问题。"""
    base = ensure_root(root)
    if not rel:
        raise FsError("请指定要重命名的文件或目录")
    src = abs_path(base, rel)
    if not os.path.exists(src):
        raise FsError(f"文件或目录不存在: {rel}", code=404)
    target_rel = join_name(parent_of(rel), new_name)
    dst = abs_path(base, target_rel)
    if os.path.exists(dst) and os.path.realpath(dst) != os.path.realpath(src):
        raise FsError(f"已存在同名文件或目录: {target_rel}", code=409)
    try:
        os.rename(src, dst)
    except OSError as e:
        raise FsError(f"重命名失败: {e}")
    return _entry(dst, target_rel, os.path.basename(dst))


def delete_entry(root: str, rel: str, recursive: bool = False) -> dict:
    base = ensure_root(root)
    if not rel:
        raise FsError("不允许删除项目根目录")
    ap = abs_path(base, rel)
    if not os.path.exists(ap):
        raise FsError(f"文件或目录不存在: {rel}", code=404)
    try:
        if os.path.isdir(ap):
            if recursive:
                shutil.rmtree(ap)
            else:
                os.rmdir(ap)  # 非空目录会抛 OSError，由下面统一翻译
        else:
            os.remove(ap)
    except OSError as e:
        raise FsError(f"删除失败（目录非空时需勾选递归删除）: {e}")
    return {"ok": True, "path": rel}
