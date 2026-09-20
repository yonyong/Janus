"""SQLite 连接与建表（Python stdlib sqlite3）。"""
import re
import sqlite3
from datetime import datetime

from .config import CONFIG

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  -- 列表顺序即 AI 任务的调度优先级（Agent 管理页可拖拽调整）
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- 每日 Token 用量上限：默认 1000 万/天，当日用满即不可用（次日自动重置）；0 表示不限额
  token_limit INTEGER NOT NULL DEFAULT 10000000,
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
  -- 详细设计文档：Agent 分析原始需求后生成（用户可再编辑），与原始需求分开存
  design_doc TEXT NOT NULL DEFAULT '',
  -- .janus/ 下的需求目录名（取需求名称清洗，创建后固定；需求名称不可改）
  dir_name TEXT NOT NULL DEFAULT '',
  -- 工作流模式：full 标准四阶段 / lite 轻量（跳过澄清与用例，直接编码，归档兜底）
  mode TEXT NOT NULL DEFAULT 'full',
  stage TEXT NOT NULL DEFAULT 'clarify',
  archived_at TEXT,
  verdict TEXT NOT NULL DEFAULT '',
  verdict_note TEXT NOT NULL DEFAULT '',
  -- 创建/最近更新时间（本地时间），需求列表卡片展示
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS tokens(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  project_ids TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  git_branch TEXT,
  -- 底层 CLI 首轮返回的外部会话 id：后续轮次用 --resume 续聊（见 adapters/codebuddy.py）
  cli_session_id TEXT,
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
CREATE TABLE IF NOT EXISTS test_cases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '',
  expected TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(requirement_id) REFERENCES requirements(id)
);
-- 工作流附件：需求附件（case_id 为空）与用例附件共用一张表；
-- 文件实体落在项目工作区 .janus/ 下（见 backend/docs.py），这里只记元信息
CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  case_id INTEGER,                        -- NULL=需求澄清阶段的附件，否则为用例附件
  filename TEXT NOT NULL,                 -- 用户上传时的原始文件名
  path TEXT NOT NULL,                     -- 项目内相对路径（.janus/...）
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(requirement_id) REFERENCES requirements(id)
);
-- 需求文档的历史版本：每次保存留一条快照，可查看与回退（回退本身也记一条）
CREATE TABLE IF NOT EXISTS requirement_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(requirement_id) REFERENCES requirements(id)
);
-- 工作区改动记录：一次 agent 运行 = 一个改动集，逐文件存改动前后的内容
CREATE TABLE IF NOT EXISTS change_sets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  session_id INTEGER,
  requirement_id INTEGER,
  source TEXT NOT NULL DEFAULT 'agent',
  note TEXT NOT NULL DEFAULT '',
  added INTEGER NOT NULL DEFAULT 0,
  modified INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS change_files(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_set_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  before TEXT,
  after TEXT,
  binary INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(change_set_id) REFERENCES change_sets(id)
);
-- 操作日志：谁（管理员口令 / 访问令牌 / 匿名）在什么时候对什么做了什么。
-- 只增不改，写失败不影响主流程（见 audit.py）。
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL DEFAULT 'anonymous',  -- admin | token | anonymous
  actor TEXT NOT NULL DEFAULT '',                -- 令牌脱敏串 / admin
  token_id INTEGER,                              -- 命中的 tokens.id（管理员为空）
  ip TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',        -- project|token|agent|requirement|file|session|changeset
  action TEXT NOT NULL,                          -- project.create / token.revoke / file.delete ...
  status TEXT NOT NULL DEFAULT 'success',        -- success | failure
  target_type TEXT NOT NULL DEFAULT '',
  target_id INTEGER,
  target_name TEXT NOT NULL DEFAULT '',
  project_id INTEGER,
  project_name TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',               -- JSON 串，记录本次改动的要点
  error TEXT NOT NULL DEFAULT '',
  -- 审计页的时间要能直接看懂/直接筛，因此存本地时间（其余表沿用 UTC 的 datetime('now')）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- Agent 调用留痕：每次调用真实 agent（工作台会话 / 一键测试 / AI 任务）都留一条，
-- 成功与失败一视同仁，记录出入参、归属、模型、token 用量与耗时。
CREATE TABLE IF NOT EXISTS agent_invocations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'session',        -- session | probe | ai_cases | ai_polish
  agent_id INTEGER,
  agent_name TEXT NOT NULL DEFAULT '',
  agent_type TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  project_id INTEGER,
  project_name TEXT NOT NULL DEFAULT '',
  requirement_id INTEGER,
  requirement_title TEXT NOT NULL DEFAULT '',
  session_id INTEGER,
  actor_type TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'success',        -- success | error
  error TEXT NOT NULL DEFAULT '',
  timed_out INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL DEFAULT '',               -- 入参（按 PROMPT_LIMIT 截断）
  response TEXT NOT NULL DEFAULT '',             -- 出参（按 RESPONSE_LIMIT 截断）
  event_count INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  -- 1 表示 token 用量是按字符估算的（CLI 未回传 usage 时的兜底）
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_id ON audit_logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_id ON agent_invocations(id DESC);
"""


def get_conn() -> sqlite3.Connection:
    CONFIG.db_path.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False：FastAPI 的同步依赖与同步路由各自跑在线程池里，
    # 可能被分配到不同工作线程（线程池繁忙时必然如此），默认校验会直接抛
    # ProgrammingError。连接只在单个请求内串行使用，不存在同一连接被并发共享的情况。
    conn = sqlite3.connect(str(CONFIG.db_path), timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # 写事务与读请求并存时，等待而不是立即抛 "database is locked"
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db(conn: sqlite3.Connection):
    # WAL 允许读写并发，避免 Agent 写库时管理台查询被阻塞
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()


# 老库升级：CREATE TABLE IF NOT EXISTS 不会补列，这里补遗漏的字段。
# 每项为 (表名, 列名, 列定义)，幂等可重复执行。
_MIGRATIONS = [
    ("tokens", "note", "TEXT NOT NULL DEFAULT ''"),
    ("tokens", "created_at", "TEXT"),
    # 工作流模式（full 标准四阶段 / lite 轻量三节点主轴）
    ("requirements", "mode", "TEXT NOT NULL DEFAULT 'full'"),
    # 工作流四阶段（需求澄清 → 编码实现 → 功能验证 → 归档验收）与验收结论
    ("requirements", "stage", "TEXT NOT NULL DEFAULT 'clarify'"),
    ("requirements", "archived_at", "TEXT"),
    ("requirements", "verdict", "TEXT NOT NULL DEFAULT ''"),
    ("requirements", "verdict_note", "TEXT NOT NULL DEFAULT ''"),
    # 详细设计文档（工作流改造：需求澄清 = 原始需求 + 详细设计两份文档）
    ("requirements", "design_doc", "TEXT NOT NULL DEFAULT ''"),
    # .janus/ 按需求分目录：目录名取需求名称，创建后固定（需求名称不可改）
    ("requirements", "dir_name", "TEXT NOT NULL DEFAULT ''"),
    # Agent 调度优先级与 Token 限额（见 AgentRepo）
    ("agents", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
    ("agents", "token_limit", "INTEGER NOT NULL DEFAULT 10000000"),
    # 需求创建/最近更新时间（需求列表卡片展示；本地时间）
    ("requirements", "created_at", "TEXT"),
    ("requirements", "updated_at", "TEXT"),
    # 底层 CLI 外部会话 id（--resume 续聊用）
    ("sessions", "cli_session_id", "TEXT"),
]


def _migrate(conn: sqlite3.Connection):
    for table, column, ddl in _MIGRATIONS:
        # 索引 1 是列名（不依赖 row_factory）
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    # 迁移前列已存在的行没有默认回填，显式补齐 created_at
    conn.execute("UPDATE tokens SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''")
    _backfill_requirement_times(conn)
    _backfill_agent_order(conn)
    _backfill_versions(conn)
    _backfill_dir_names(conn)


def _backfill_requirement_times(conn: sqlite3.Connection):
    """老需求没有 created_at/updated_at：created_at 尽量从标题 v-时间戳- 前缀还原，
    还原不出（或时间戳非法）用当前本地时间兜底；历史编辑时间无法追溯，updated_at
    先与 created_at 对齐，之后的每次修改由 RequirementRepo.update 刷新。"""
    rows = conn.execute(
        "SELECT id, title FROM requirements WHERE created_at IS NULL OR created_at = ''"
    ).fetchall()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for row in rows:
        rid, title = row[0], row[1]
        ts = ""
        m = re.match(r"^v-(\d{14})-", title or "")
        if m:
            s = m.group(1)
            ts = f"{s[0:4]}-{s[4:6]}-{s[6:8]} {s[8:10]}:{s[10:12]}:{s[12:14]}"
            try:
                datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                ts = ""
        if not ts:
            ts = now
        conn.execute(
            "UPDATE requirements SET created_at = ?, updated_at = ? WHERE id = ?",
            (ts, ts, rid),
        )


def _backfill_dir_names(conn: sqlite3.Connection):
    """老需求的 dir_name 为空时按标题回填（同项目内重名自动加后缀）。

    目录名创建后固定、需求名称不可改，所以按当前标题算一次就是终局。
    延迟导入 docs 是为避免 db ← docs ← files 的加载环。
    """
    from .docs import unique_dir_name  # noqa: PLC0415

    rows = conn.execute(
        "SELECT id, project_id, title FROM requirements "
        "WHERE dir_name = '' OR dir_name IS NULL"
    ).fetchall()
    for rid, pid, title in rows:
        name = unique_dir_name(conn, pid, title)
        conn.execute("UPDATE requirements SET dir_name=? WHERE id=?", (name, rid))
    if rows:
        conn.commit()


def _backfill_agent_order(conn: sqlite3.Connection):
    """老库的 agents 排序列全是 0（迁移刚加上）时按 id 补齐初始顺序。

    用「还存在 sort_order=0 的行才补」做守卫：拖拽排序落库后取值是 1..n，永不
    会再出现 0，因此重复执行安全，也不会覆盖用户拖出来的顺序。
    """
    conn.execute(
        "UPDATE agents SET sort_order = id WHERE sort_order = 0"
    )


def _backfill_versions(conn: sqlite3.Connection):
    """给「版本表还是空的」老需求补一条初始版本。

    版本功能上线前建的需求在 requirement_versions 里没有任何行，历史抽屉会空着，
    看起来像功能坏了。这里按当前内容补一条 source=create 的版本 —— 用 NOT EXISTS
    做守卫，所以重复执行安全；只要该需求已有任意版本就不再动它。
    """
    conn.execute(
        """INSERT INTO requirement_versions(requirement_id, title, description, source, note)
           SELECT r.id, r.title, r.description, 'create', '功能上线前的历史回填'
           FROM requirements r
           WHERE NOT EXISTS (
               SELECT 1 FROM requirement_versions v WHERE v.requirement_id = r.id
           )"""
    )


def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)
