"""脚本子进程执行约定：父子 UTF-8 一致、输出采集、可选 JANUS_SCRIPT_LOG。

平台父进程按 UTF-8 + errors=replace 解码管道；同时给子进程注入
PYTHONUTF8 / PYTHONIOENCODING，避免「子进程按 locale(cp936) 写、父进程按
UTF-8 读」或反向错配导致整段 output 丢失。

可选副通道：注入 JANUS_SCRIPT_LOG（绝对路径）；脚本可追加写入；进程结束后
平台回读并并入 output（管道为空时作为主内容，否则附加）。
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from typing import Any


def build_script_env(janus_script_log: str | None = None) -> dict[str, str]:
    """构造脚本子进程环境：继承当前 env，强制 Python I/O 为 UTF-8。"""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    if janus_script_log:
        env["JANUS_SCRIPT_LOG"] = janus_script_log
    return env


def _as_text(chunk: str | bytes | None) -> str:
    if chunk is None:
        return ""
    if isinstance(chunk, bytes):
        return chunk.decode("utf-8", errors="replace")
    return chunk


def merge_script_output(
    stdout: str | bytes | None,
    stderr: str | bytes | None,
    log_path: str | None = None,
) -> str:
    """合并 stdout / stderr / 可选日志文件为单段 output。"""
    out = _as_text(stdout)
    err = _as_text(stderr)
    if err:
        out = (out + "\n" if out else "") + "[stderr]\n" + err
    if log_path and os.path.isfile(log_path):
        try:
            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                log_text = f.read()
        except OSError:
            log_text = ""
        if log_text.strip():
            if not out.strip():
                out = log_text
            elif log_text not in out:
                out = (out + "\n" if out else "") + "[janus-script-log]\n" + log_text
    return out


def run_captured(
    cmd: list[str],
    *,
    cwd: str,
    timeout: int,
    with_script_log: bool = True,
) -> dict[str, Any]:
    """执行命令并采集输出。

    返回::
        {
          "ran": True,
          "returncode": int,
          "output": str,
          "timed_out": False,
        }
    或超时::
        {"ran": False, "reason": "timeout", "output": str, "timed_out": True}
    解释器缺失 / OS 错误仍抛给调用方用原有 except 处理（本函数只吃 TimeoutExpired）。
    """
    log_path: str | None = None
    if with_script_log:
        fd, log_path = tempfile.mkstemp(prefix="janus-script-log-", suffix=".log")
        os.close(fd)
    try:
        env = build_script_env(log_path)
        try:
            proc = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                timeout=timeout,
                env=env,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired as e:
            out = merge_script_output(e.stdout, e.stderr, log_path)
            return {
                "ran": False,
                "reason": "timeout",
                "output": out,
                "timed_out": True,
                "returncode": None,
            }
        out = merge_script_output(proc.stdout, proc.stderr, log_path)
        return {
            "ran": True,
            "returncode": proc.returncode,
            "output": out,
            "timed_out": False,
        }
    finally:
        if log_path and os.path.isfile(log_path):
            try:
                os.remove(log_path)
            except OSError:
                pass
