"""改动 diff：优先 git diff，非 git 仓库时给出提示。"""
import subprocess


def compute(project_path: str) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", project_path, "diff"],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout
    except Exception:
        pass
    return "(无 git diff：目标项目非 git 仓库，或本次未产生改动)"


def status_files(project_path: str, limit: int = 200) -> dict:
    """列出工作区改动文件（git status --porcelain），供归档验收汇总。

    返回 {"available": bool, "files": [{"status","path"}], "truncated": bool}：
    非 git 仓库 / git 不可用时 available=False，调用方应显示「无法统计」而不是空列表。
    """
    try:
        out = subprocess.run(
            ["git", "-C", project_path, "status", "--porcelain"],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return {"available": False, "files": [], "truncated": False}
    if out.returncode != 0:
        return {"available": False, "files": [], "truncated": False}
    files = []
    truncated = False
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        # porcelain 格式：XY <path>（重命名为 "XY old -> new"）
        code, _, path = line[:2], line[2:3], line[3:]
        path = path.strip().strip('"')
        if " -> " in path:
            path = path.split(" -> ", 1)[1].strip().strip('"')
        if len(files) >= limit:
            truncated = True
            break
        files.append({"status": code.strip() or "??", "path": path})
    return {"available": True, "files": files, "truncated": truncated}
