"""平台配置。所有路径相对仓库 coding-agent-platform/ 根目录。"""
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent


class Config:
    db_path = BASE / "data" / "app.db"
    web_dist = BASE / "web" / "dist"
    web_index_fallback = BASE / "web" / "dist" / "index.html"
    host = "0.0.0.0"
    port = 8000
    default_token_ttl_days = 30


CONFIG = Config()
