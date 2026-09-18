#!/usr/bin/env python3
"""假 agent CLI：读取 stdin JSON，模拟改码 + 跑测试，逐行输出 AgentEvent JSON。
用于端到端联调；接真实 CodeBuddy 时由 CodeBuddyAdapter 调其 CLI 替代本文件。
"""
import json
import os
import sys


def main():
    data = json.loads(sys.stdin.read())
    message = data.get("message", "")
    project_path = data.get("project_path", ".")
    emit = lambda **kw: print(json.dumps(kw, ensure_ascii=False))

    emit(type="status", pane="message", text="fake agent 开始处理需求")
    target = os.path.join(project_path, "agent_output.txt")
    with open(target, "w", encoding="utf-8") as f:
        f.write(f"# requirement\n{message}\n")
    emit(type="edit", pane="code", text=f"modified {target}", payload={"path": target})
    emit(type="message", pane="message", text=f"已根据需求修改：{message}")
    emit(type="test", pane="test", payload={"cmd": "pytest", "passed": True, "output": "1 passed"})


if __name__ == "__main__":
    main()
