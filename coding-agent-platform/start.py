"""一键启动：初始化数据库并启动 FastAPI。"""
import uvicorn
from backend.config import CONFIG
from backend.db import get_conn, init_db


def main():
    init_db(get_conn())
    uvicorn.run("backend.app:app", host=CONFIG.host, port=CONFIG.port, reload=False)


if __name__ == "__main__":
    main()
