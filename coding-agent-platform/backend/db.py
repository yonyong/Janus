"""SQLite 连接与建表（Python stdlib sqlite3）。"""
import sqlite3
from .config import CONFIG

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  disk_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS tokens(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  project_ids TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  git_branch TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(requirement_id) REFERENCES requirements(id),
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  pane TEXT NOT NULL DEFAULT 'message',
  content TEXT NOT NULL,
  has_edit INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
"""


def get_conn() -> sqlite3.Connection:
    CONFIG.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(CONFIG.db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection):
    conn.executescript(SCHEMA)
    conn.commit()


def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)
