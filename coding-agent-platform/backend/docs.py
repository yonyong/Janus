"""工作流文档的工作区落盘。

需求澄清、用例配置、编码实现、归档验收四个阶段的文档与附件，都按**需求**分目录
落在项目工作区里，编码 Agent 才能在对话里按路径直接读到，不必靠平台把内容塞进
提示词。目录名取需求名称（创建需求时定死，之后需求名称不可改，见 app.py 的
PATCH /api/requirements/{rid}），数据库 requirements.dir_name 是权威映射：

    .janus/{需求目录}/requirement/origin.md    原始需求文档（requirements.description 镜像）
    .janus/{需求目录}/requirement/design.md    详细设计文档（requirements.design_doc 镜像）
    .janus/{需求目录}/requirement/attach/*     需求澄清阶段的用户附件
    .janus/{需求目录}/usecase/usercase.md      用例清单导出（「执行配置的单测」按它来）
    .janus/{需求目录}/usecase/cases-draft.md   AI 用例草稿（对话生成用例时 agent 写这里，导入后落库）
    .janus/{需求目录}/usecase/attach/*         用例附件
    .janus/{需求目录}/other/*.md               编码过程文件（agent 按约定写，平台不强制生成）
    .janus/{需求目录}/arch/test-result.md      测试报告（agent 按约定写）

目录名刻意用 `.janus`：
- 带点前缀，不干扰项目自己的文件；
- snapshots.py 已把它列入 IGNORE_DIRS，平台写文档不会被误记成 agent 改动；
- 项目内相对路径对 Agent 稳定，常用指令可以直接写死路径引用。

数据库仍是文档正文的权威来源（需求文档有版本历史），落盘是单向镜像：
保存时写工作区，工作区被用户手改不回写库。
"""
import os
import re
import shutil
import sqlite3

from . import files as FS

# 工作区内的固定布局（相对路径一律用 /，Windows 下落盘时由 os.path.join 转换）
JANUS_DIR = ".janus"

MAX_ATTACH_BYTES = 20 * 1024 * 1024  # 单个附件上限：设计稿、日志等够用，又不至于拖垮内存

# 文件名里的非法字符（Windows 保留字符 + 控制符）：统一替换成 _
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# 需求目录名长度上限：Windows 路径 260 字符留给深层文件，目录名别太长
_MAX_DIR_LEN = 60


def sanitize_dir_name(title: str) -> str:
    """需求标题 → 目录名：非法字符（含路径分隔符）替换成 _（连续折叠），清完为空给占位名。

    注意不能取 basename：标题里的 / 是要替换的内容，不是路径层级。
    """
    base = (title or "").strip()
    cleaned = _UNSAFE.sub("_", base).strip(". ")[:_MAX_DIR_LEN].rstrip(". ")
    return re.sub(r"_+", "_", cleaned) or "requirement"


def unique_dir_name(conn: sqlite3.Connection, pid: int, title: str) -> str:
    """同项目内不重名的需求目录名：重名自动加 -2、-3 后缀。

    requirements.dir_name 创建后固定，因此用查询去重是可靠的（不会再有改名搅局）。
    """
    base = sanitize_dir_name(title)
    name, n = base, 1
    while conn.execute(
        "SELECT 1 FROM requirements WHERE project_id=? AND dir_name=?", (pid, name)
    ).fetchone():
        n += 1
        name = f"{base}-{n}"
    return name


# -- 按需求目录拼路径（dir_name 来自 requirements.dir_name，已清洗） --

def requirement_origin(dir_name: str) -> str:
    return f"{JANUS_DIR}/{dir_name}/requirement/origin.md"


def requirement_design(dir_name: str) -> str:
    return f"{JANUS_DIR}/{dir_name}/requirement/design.md"


def requirement_attach_subdir(dir_name: str) -> str:
    """save_attachment 的 subdir 参数（其内部再拼 .janus/ 前缀）。"""
    return f"{dir_name}/requirement/attach"


def usecase_doc(dir_name: str) -> str:
    return f"{JANUS_DIR}/{dir_name}/usecase/usercase.md"


def usecase_draft(dir_name: str) -> str:
    """AI 用例草稿：对话里让 agent 生成用例时写这里，平台「从工作区导入」按它落库。

    与 usercase.md（数据库导出的权威清单）分开，避免草稿和导出互相覆盖。
    """
    return f"{JANUS_DIR}/{dir_name}/usecase/cases-draft.md"


def usecase_attach_subdir(dir_name: str) -> str:
    return f"{dir_name}/usecase/attach"


# 一需求一份「总验收脚本」入口：日常验收只跑脚本（AI 不再临场想测法）。
# 语言不限，约定入口文件名 accept.*；默认 accept.py，按扩展名选解释器（见 acceptance.py）。
ACCEPT_CANDIDATES = ("accept.py", "accept.sh", "accept.mjs", "accept.js")


def accept_script(dir_name: str, name: str = "accept.py") -> str:
    return f"{JANUS_DIR}/{dir_name}/usecase/{name}"


def usecase_dir(dir_name: str) -> str:
    return f"{JANUS_DIR}/{dir_name}/usecase"


def other_dir(dir_name: str) -> str:
    return f"{JANUS_DIR}/{dir_name}/other"


def test_result_doc(dir_name: str) -> str:
    return f"{JANUS_DIR}/{dir_name}/arch/test-result.md"


def req_dir_of(dir_name: str) -> str:
    return f"{JANUS_DIR}/{dir_name}"


def agent_context_brief(dir_name: str) -> str:
    """会话聊天注入给 Agent 的「工作区文档规范」。

    聊天指令是业务人员自由输入的（「请生成详细设计」），Agent 对平台目录规范一无所知，
    只会靠探索工作区猜路径——工作区里若有遗留的 .janus/docs/ 老布局，它就会把设计写进
    老路径。每轮会话消息前拼上这段约定，聊天 Agent 与快捷指令就共享同一套路径认知。
    """
    if not (dir_name or "").strip():
        return ""
    return (
        f"【平台约定】本次会话绑定需求「{dir_name}」，工作流文档固定按以下项目内相对路径读写，"
        "请严格遵守，不要写到其他位置，尤其不要使用 .janus/docs/ 这类旧路径，"
        "也不要在项目根目录另建设计文档目录：\n"
        f"- 原始需求文档：{requirement_origin(dir_name)}\n"
        f"- 详细设计文档：{requirement_design(dir_name)}（生成或更新详细设计一律写这里）\n"
        f"- 需求附件：{JANUS_DIR}/{dir_name}/requirement/attach/ 下\n"
        f"- 用例清单：{usecase_doc(dir_name)}\n"
        f"- AI 用例草稿：{usecase_draft(dir_name)}（生成 / 补充功能验证用例一律写这里，"
        "文件内容为一个 ```json 代码块，对象数组字段 title/steps/expected，导入后平台会删除该文件）\n"
        f"- 编码过程文档（实现说明、决策记录等）：{other_dir(dir_name)}/ 下\n"
        f"- 测试报告：{test_result_doc(dir_name)}（必须是 Markdown 表格，表头："
        "用例 | 标题 | 结果 | 说明；结果列每条用例只能取：通过 / 失败 / 跳过 / 未执行，"
        "平台会解析该表格自动回写用例状态，纯文字版报告无法被平台识别）\n\n"
    )


def _safe_name(name: str) -> str:
    """清洗上传文件名：去路径分量、替换非法字符；清完为空就给个占位名。"""
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    cleaned = _UNSAFE.sub("_", base).strip(". ")
    return cleaned[:120] or "attachment"


def write_doc(root: str, rel: str, content: str) -> str:
    """把文档正文写到工作区（自动建目录）。失败抛 FsError，由调用方决定是否兜底。"""
    base = FS.ensure_root(root)
    ap = FS.abs_path(base, rel)
    os.makedirs(os.path.dirname(ap), exist_ok=True)
    with open(ap, "w", encoding="utf-8", newline="") as f:
        f.write(content or "")
    return rel


def save_attachment(root: str, subdir: str, filename: str, data: bytes) -> str:
    """把一个附件存进工作区 .janus/<subdir>/（subdir 如 attachments/r3、cases/c12）。

    同名文件自动加 -1、-2 后缀，绝不覆盖已有附件。返回项目内相对路径。
    """
    base = FS.ensure_root(root)
    safe = _safe_name(filename)
    stem, dot, ext = safe.rpartition(".")
    # "a.b.c" -> rpartition 得到 ("a.b", ".", "c")；无扩展名时 stem 为空
    if not dot or not stem:
        stem, ext = safe, ""
    rel_dir = f"{JANUS_DIR}/{subdir}"
    ap_dir = FS.abs_path(base, rel_dir)
    os.makedirs(ap_dir, exist_ok=True)
    n = 0
    while True:
        candidate = f"{stem}-{n}{ext}" if n else safe
        rel = f"{rel_dir}/{candidate}"
        ap = FS.abs_path(base, rel)
        if not os.path.exists(ap):
            break
        n += 1
    if len(data) > MAX_ATTACH_BYTES:
        raise FS.FsError(f"附件 {safe} 超过 {MAX_ATTACH_BYTES // 1024 // 1024}MB 上限", code=400)
    with open(ap, "wb") as f:
        f.write(data)
    return rel


def delete_attachment(root: str, rel: str) -> None:
    """删除附件文件；不存在视为已删（幂等），路径越界由 abs_path 拒绝。"""
    try:
        base = FS.ensure_root(root)
        ap = FS.abs_path(base, rel)
    except FS.FsError:
        return
    if os.path.isfile(ap):
        try:
            os.remove(ap)
        except OSError:
            pass  # Windows 句柄释放延迟：留文件不留记录，不算失败


def export_test_cases(cases: list[dict], attachments: list[dict], dir_name: str = "") -> str:
    """把用例清单导出成 Markdown，给编码 Agent 当「配置好的单测」来执行。

    每条用例一个 ## 小节，编号与平台一致；附件写绝对可信的项目内相对路径。
    没有用例时写占位说明（文件仍生成，避免 Agent 找不到路径报错）。
    头部带上过程文件与测试报告的约定路径（agent 按约定写，平台不强制生成）。
    """
    att_by_case: dict[int, list[dict]] = {}
    req_atts: list[dict] = []
    for a in attachments or []:
        if a.get("case_id"):
            att_by_case.setdefault(a["case_id"], []).append(a)
        else:
            req_atts.append(a)

    lines: list[str] = [
        "# 测试用例清单",
        "",
        "> 本文件由 Janus 平台在「用例配置」阶段自动导出，请**逐条执行**下列用例，",
        "> 并以每条的「预期结果」为验证标准；不要改写本文件中的用例内容。",
        "",
    ]
    if dir_name:
        lines += [
            "## 路径约定",
            "",
            f"- 编码过程中的说明性文档（实现说明、决策记录等）写入 `{other_dir(dir_name)}/`；",
            f"- 总验收脚本（一需求一份）入口：`{accept_script(dir_name)}`（语言不限，"
            "默认 Python；脚本读取本清单、跳过标「人工」的用例、按标题逐条检查）；",
            f"- 全部用例执行完后，把测试报告写入 `{test_result_doc(dir_name)}`。"
            "报告必须是 Markdown 表格（表头：用例 | 标题 | 结果 | 说明，每条用例一行，"
            "结果列只能取：通过 / 失败 / 跳过 / 未执行）；平台解析该表格自动回写用例状态。",
            "",
        ]
    if req_atts:
        lines.append("## 需求附件")
        lines.append("")
        for a in req_atts:
            lines.append(f"- {a['path']}（{a['filename']}）")
        lines.append("")
    if not cases:
        lines.append("（尚未配置任何用例）")
        lines.append("")
    for i, c in enumerate(cases, 1):
        lines.append(f"## 用例 {i:02d}：{c.get('title') or ''}")
        lines.append("")
        lines.append(f"- 状态：{c.get('status') or 'pending'}")
        # 人工项：总验收脚本必须跳过，交给人在页面上逐条勾选
        lines.append(f"- 人工：{'是' if c.get('is_manual') else '否'}")
        if (c.get("steps") or "").strip():
            lines.append("- 操作步骤：")
            for ln in str(c["steps"]).splitlines():
                lines.append(f"  {ln}" if ln.strip() else "")
        if (c.get("expected") or "").strip():
            lines.append("- 预期结果：")
            for ln in str(c["expected"]).splitlines():
                lines.append(f"  {ln}" if ln.strip() else "")
        if (c.get("note") or "").strip():
            lines.append(f"- 备注：{c['note']}")
        for a in att_by_case.get(c.get("id"), []):
            lines.append(f"- 附件：{a['path']}（{a['filename']}）")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


# ---------------- 老布局一次性迁移（.janus/docs/ 等扁平结构 → 按需求分目录） ----------------

_LEGACY_REQ_ATTACH_PREFIX = f"{JANUS_DIR}/attachments/"
_LEGACY_CASE_ATTACH_PREFIX = f"{JANUS_DIR}/cases/"


def _move_file(root: str, old_rel: str, new_rel: str) -> bool:
    """把 old_rel 搬到 new_rel（目标已存在或源不存在都跳过）。成功返回 True。"""
    try:
        base = FS.ensure_root(root)
        src = FS.abs_path(base, old_rel)
        dst = FS.abs_path(base, new_rel)
    except FS.FsError:
        return False
    if not os.path.isfile(src) or os.path.exists(dst):
        return False
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        shutil.move(src, dst)
        return True
    except OSError:
        return False


def migrate_legacy_attachments(root: str, atts: list[dict]) -> list[tuple[int, str]]:
    """把老布局的附件文件搬到新目录，返回 [(附件id, 新相对路径)] 供调用方更新库。

    老布局：需求附件在 .janus/attachments/r<rid>/、用例附件在 .janus/cases/c<cid>/。
    新布局：都归到所属需求的 .janus/{dir}/requirement|usecase/attach/ 下。
    """
    moved: list[tuple[int, str]] = []
    for a in atts or []:
        old = (a.get("path") or "").replace("\\", "/")
        rid, cid = a.get("requirement_id"), a.get("case_id")
        dir_name = a.get("dir_name") or ""
        if not old or not dir_name or not rid:
            continue
        if old.startswith(f"{_LEGACY_REQ_ATTACH_PREFIX}r{rid}/") and not cid:
            new = f"{req_dir_of(dir_name)}/requirement/attach/{old.rsplit('/', 1)[-1]}"
        elif old.startswith(_LEGACY_CASE_ATTACH_PREFIX) and cid:
            new = f"{req_dir_of(dir_name)}/usecase/attach/{old.rsplit('/', 1)[-1]}"
        else:
            continue  # 已是新布局或来历不明，不动
        if _move_file(root, old, new):
            moved.append((a["id"], new))
    return moved


def _relocate_or_drop_legacy(root: str, old_rel: str, new_rel: str, dir_name: str) -> None:
    """老文件搬不去新位置（目标已存在）时的兜底：内容一致就删掉老文件，
    不一致就归档到 other/legacy-* 留档。总之不让它留在老位置继续误导 Agent
    （真实案例：聊天 Agent 发现 .janus/docs/requirement.md，就把设计写进了老路径）。
    """
    try:
        base = FS.ensure_root(root)
        src = FS.abs_path(base, old_rel)
    except FS.FsError:
        return
    if not os.path.isfile(src):
        return
    try:
        dst = FS.abs_path(base, new_rel)
        if os.path.isfile(dst) and _read_text(src) == _read_text(dst):
            os.remove(src)  # 新版镜像已在，老文件是冗余拷贝
            return
    except (FS.FsError, OSError):
        pass
    stem, ext = os.path.splitext(os.path.basename(old_rel))
    n = 0
    while True:
        rel = f"{other_dir(dir_name)}/legacy-{stem}{f'-{n}' if n else ''}{ext}"
        ap = os.path.join(base, *rel.split("/"))
        if not os.path.exists(ap):
            break
        n += 1
    try:
        os.makedirs(os.path.dirname(ap), exist_ok=True)
        shutil.move(src, ap)
    except OSError:
        pass  # 搬不动就留在原地，别让迁移失败影响启动


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def migrate_legacy_docs(root: str, dir_name: str) -> None:
    """单需求项目：把老布局的文档镜像搬到新位置（多需求项目内容归属不明，不动）。

    老镜像都是数据库的单向拷贝，搬失败无伤大雅——下次保存会在新路径重新生成。
    目标已存在且内容不一致时，老文件归档进 other/legacy-*（见 _relocate_or_drop_legacy）。
    """
    if not dir_name:
        return
    for old, new in (
        (f"{JANUS_DIR}/docs/requirement.md", requirement_origin(dir_name)),
        (f"{JANUS_DIR}/docs/design.md", requirement_design(dir_name)),
        (f"{JANUS_DIR}/test-cases.md", usecase_doc(dir_name)),
    ):
        if not _move_file(root, old, new):
            _relocate_or_drop_legacy(root, old, new, dir_name)
    # 老目录空了就顺手删掉，别给 Agent 留一个看似有效的旧路径
    try:
        base = FS.ensure_root(root)
        docs_dir = FS.abs_path(base, f"{JANUS_DIR}/docs")
        if os.path.isdir(docs_dir) and not os.listdir(docs_dir):
            os.rmdir(docs_dir)
    except (FS.FsError, OSError):
        pass
