"""回归测试：SQLite 连接必须能跨线程使用。

FastAPI 的同步依赖（get_db）与同步路由分别跑在线程池里，线程池繁忙时
两者会被分配到不同工作线程；sqlite3 默认会对此直接抛
ProgrammingError，表现为并发请求偶发 500。
"""
import threading

from backend.db import get_conn, init_db


def test_conn_usable_across_threads():
    conn = get_conn()
    errors = []
    try:
        init_db(conn)

        def work():
            try:
                conn.execute("SELECT COUNT(*) FROM projects").fetchone()
                conn.close()
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        t = threading.Thread(target=work)
        t.start()
        t.join()
        assert not errors, f"跨线程使用连接失败: {errors[0]!r}"
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def test_conn_busy_timeout_configured():
    conn = get_conn()
    try:
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] > 0
    finally:
        conn.close()
