"""平台配置。所有路径相对仓库 coding-agent-platform/ 根目录。"""
import os
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
    default_token_ttl_days = 30
    # 管理员口令：留空表示未启用，管理端点保持开放（向后兼容）。
    admin_token = _env("CAP_ADMIN_TOKEN", "")


CONFIG = Config()
