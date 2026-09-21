"""分享链接基址：业务人员走前端 Vite（局域网 IP + 5173），不能拼成后端 :8000。"""
from unittest import mock

from backend import config as cfg
from backend import app as app_module
from backend.db import get_conn, init_db
from backend import repositories as R
from backend.models import AdminTokenIssue, TokenIssue


def _new(conn):
    conn.execute("DELETE FROM tokens")
    conn.execute("DELETE FROM projects")
    conn.commit()


def test_public_share_base_uses_lan_ip_and_frontend_port():
    env = {"CAP_PUBLIC_BASE_URL": "", "CAP_PUBLIC_PORT": ""}
    with mock.patch.object(cfg, "detect_lan_ip", return_value="192.168.1.42"):
        with mock.patch.dict("os.environ", env, clear=False):
            # _env 还会读 .env，临时清空内存缓存
            with mock.patch.object(cfg, "_ENV", {}):
                assert cfg.public_share_base() == "http://192.168.1.42:5173"


def test_public_share_base_env_override():
    with mock.patch.dict("os.environ", {"CAP_PUBLIC_BASE_URL": "http://example.com:9999"}, clear=False):
        assert cfg.public_share_base() == "http://example.com:9999"


def test_reveal_link_is_lan_frontend_not_backend_8000():
    conn = get_conn(); init_db(conn); _new(conn)
    pid = R.ProjectRepo.create(conn, "demo", "/tmp/demo")["id"]
    # app 里是 `from .config import public_share_base`，要 patch 绑定名
    with mock.patch.object(app_module, "public_share_base", return_value="http://10.0.0.8:5173"):
        r = app_module.admin_issue_token(
            AdminTokenIssue(project_ids=[pid], note="n"), db=conn, _ok=True
        )
        assert r["link"] == f"http://10.0.0.8:5173/?token={r['token']}", r["link"]
        revealed = app_module.admin_reveal_token(tid=r["id"], db=conn, _ok=True)
        assert revealed["link"] == f"http://10.0.0.8:5173/?token={r['token']}", revealed["link"]
        assert ":8000" not in revealed["link"]
        assert "localhost" not in revealed["link"]


def test_project_issue_token_link_uses_share_base():
    conn = get_conn(); init_db(conn); _new(conn)
    pid = R.ProjectRepo.create(conn, "demo", "/tmp/demo")["id"]
    with mock.patch.object(app_module, "public_share_base", return_value="http://10.0.0.8:5173"):
        r = app_module.issue_token(
            pid, TokenIssue(project_ids=[pid]), db=conn, _ok=True
        )
        assert r["link"] == f"http://10.0.0.8:5173/?token={r['token']}", r["link"]
