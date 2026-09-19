"""清理自检脚本写入的测试令牌（project_ids 为空的令牌）。"""
import json
import sqlite3
import sys

sys.path.insert(0, r"D:\develop\project\Janus\coding-agent-platform")

from backend.db import get_conn

conn = get_conn()
rows = conn.execute("SELECT id, project_ids, expires_at FROM tokens").fetchall()
targets = [r["id"] for r in rows if r["project_ids"] == "[]"]
for tid in targets:
    conn.execute("DELETE FROM tokens WHERE id=?", (tid,))
conn.commit()
left = conn.execute("SELECT COUNT(*) FROM tokens").fetchone()[0]
conn.close()

print(json.dumps({"deleted": len(targets), "remaining_tokens": left}, ensure_ascii=False))
