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
