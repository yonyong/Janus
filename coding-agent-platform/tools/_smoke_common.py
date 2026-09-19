"""HTTP 冒烟脚本共用脚手架：临时库 + 临时工作区 + 真实 uvicorn + 请求/断言工具。

单元测试直接调路由函数，绕过了 FastAPI 的依赖注入与查询参数解析；
冒烟脚本补这一段：起真实 uvicorn，用 HTTP 覆盖接口层。

注意导入顺序：`CAP_ADMIN_TOKEN` 与 `CONFIG.db_path` 必须在 `backend.app` 之前设置，
否则应用会去动真实的 app.db。因此这些动作全部藏在 `boot()` 里。
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class Smoker:
    def __init__(self, base: str, admin: str, tmp: Path, ws: Path):
        self.base = base
        self.admin = admin
        self.tmp = tmp
        self.ws = ws
        self.fails: list[str] = []
        self._srv = None

    # ---------------- 请求 ----------------

    def call(self, method, path, qp=None, body=None):
        url = self.base + path
        if qp:
            url += "?" + urllib.parse.urlencode({k: v for k, v in qp.items() if v is not None})
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                return e.code, json.loads(raw)
            except Exception:  # noqa: BLE001
                return e.code, {"raw": raw[:200]}

    def check(self, label, got, want):
        ok = got == want
        print(f"{'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f" (期望 {want!r})"))
        if not ok:
            self.fails.append(label)

    def stream_run(self, sid, message, token=None, admin=None, timeout=120):
        """触发一次 agent 运行，把 SSE 读到底（等到 done），返回收到的事件列表。

        会话执行是 SSE + 后台 run 的组合：不把流读完就拿不到「跑完了」这个信号，
        后面的断言（改动记录是否落库）也就无从谈起。
        """
        qp = urllib.parse.urlencode(
            {k: v for k, v in {"message": message, "token": token, "admin": admin}.items()
             if v is not None})
        url = f"{self.base}/api/sessions/{sid}/events?{qp}"
        events = []
        with urllib.request.urlopen(url, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                try:
                    d = json.loads(line[6:])
                except Exception:  # noqa: BLE001
                    continue
                events.append(d)
                if d.get("type") == "done":
                    break
        return events

    # ---------------- 生命周期 ----------------

    def register_adapter(self, adapter):
        """注册一个仅存在于本次冒烟进程里的 agent 适配器（用于模拟模型输出）。"""
        from backend.agent_runtime import AgentRegistry
        AgentRegistry.register(adapter.type, adapter)

    def stop(self):
        if self._srv is not None:
            self._srv.should_exit = True
        time.sleep(0.4)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def finish(self):
        print("\n" + ("全部通过" if not self.fails else f"失败 {len(self.fails)} 项: {self.fails}"))
        return 1 if self.fails else 0


def boot(port: int, admin: str = "smoke-admin", workspace: bool = True) -> Smoker:
    """准备环境并启动 uvicorn（守护线程），返回可用的 Smoker。"""
    os.environ["CAP_ADMIN_TOKEN"] = admin
    tmp = Path(tempfile.mkdtemp(prefix="cap-smoke-"))
    ws = tmp / "ws"
    ws.mkdir(parents=True, exist_ok=True)
    if workspace:
        (ws / "src").mkdir(exist_ok=True)
        (ws / "README.md").write_text("# hi\n", encoding="utf-8")
        (ws / "src" / "app.py").write_text("print('hi')\n", encoding="utf-8")

    from backend.config import CONFIG
    CONFIG.db_path = tmp / "app.db"

    import uvicorn
    from backend.app import app

    class _Server(uvicorn.Server):
        def install_signal_handlers(self):
            pass

    srv = _Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=srv.run, daemon=True).start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.1)
    assert srv.started, "uvicorn 未启动"

    s = Smoker(f"http://127.0.0.1:{port}", admin, tmp, ws)
    s._srv = srv
    return s
