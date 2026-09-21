"""平台配置。所有路径相对仓库 coding-agent-platform/ 根目录。"""
import os
import socket
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent


def _load_dotenv() -> dict:
    """极简 .env 读取（避免引入 python-dotenv 依赖）。"""
    f = BASE / ".env"
    if not f.is_file():
        return {}
    out = {}
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


_ENV = _load_dotenv()


def _env(name: str, default: str = "") -> str:
    return os.getenv(name) or _ENV.get(name, default)


class Config:
    db_path = BASE / "data" / "app.db"
    web_dist = BASE / "web" / "dist"
    web_index_fallback = BASE / "web" / "dist" / "index.html"
    host = "0.0.0.0"
    port = 8000
    # 开发模式分享链接指向 Vite 前端端口，而非后端 API 端口。
    frontend_port = 5173
    default_token_ttl_days = 30
    # 管理员口令：留空表示未启用，管理端点保持开放（向后兼容）。
    admin_token = _env("CAP_ADMIN_TOKEN", "")


CONFIG = Config()


def detect_lan_ip() -> str:
    """探测本机局域网 IPv4，供分享链接使用。失败时回退 127.0.0.1。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            # 不真正发包，只借路由表选出出口网卡地址
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return "127.0.0.1"


def public_share_base() -> str:
    """分享链接基址：业务人员访问的是前端（局域网 IP + Vite :5173），不是后端 :8000。

    覆盖优先级：
      1. CAP_PUBLIC_BASE_URL（完整基址，如 http://192.168.1.10:5173）
      2. 探测到的局域网 IP + CAP_PUBLIC_PORT（默认 5173）
    """
    override = (_env("CAP_PUBLIC_BASE_URL") or "").rstrip("/")
    if override:
        return override
    port = (_env("CAP_PUBLIC_PORT") or "").strip() or str(CONFIG.frontend_port)
    return f"http://{detect_lan_ip()}:{port}"
