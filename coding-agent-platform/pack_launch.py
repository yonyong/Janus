"""Janus 桌面应用启动入口：双击 Janus.exe 弹出原生窗口，关窗即退出。

流程：读取 config.ini → 初始化数据库 → 后台线程起 uvicorn → 等待端口就绪 → 打开 pywebview 窗口。

配置来源（优先级从高到低）：
  1. exe 同级的 config.ini —— 桌面版的主配置入口，首次启动自动生成
  2. 进程环境变量（CAP_ADMIN_TOKEN / CAP_PUBLIC_PORT / CAP_PUBLIC_BASE_URL）
  3. exe 同级的 .env（仅用于首次生成 config.ini 时迁移旧口令）
  4. backend/config.py 里的内置默认值

路径说明（PyInstaller 关键点）：
打包后 config.py 里靠 __file__ 推导的 BASE / web_dist / db_path 全部指向临时解压目录，
导致前端挂不上、数据库写不进。所以要在 import backend.app 之前把它们改到正确位置：

  * 只读资源（前端产物、图标）—— PyInstaller 6.x 放在 exe 旁的 _internal/，即 sys._MEIPASS；
    开发期则是脚本所在目录。
  * 可写数据（config.ini、app.db、logs）—— 必须落在 exe 旁边，不能进只读资源目录。

开发期直接 `python pack_launch.py` 也能跑，此时各路径都取脚本所在目录。
"""
from __future__ import annotations

import configparser
import ctypes
import os
import secrets
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

WINDOW_TITLE = "Janus · AI 原生开发平台"
MUTEX_NAME = "Local\\JanusDesktopApp"
ERROR_ALREADY_EXISTS = 183
SERVER_READY_TIMEOUT = 40.0


def _app_dir() -> Path:
    """打包后是 exe 所在目录；开发期是脚本所在目录。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _resource_dir() -> Path:
    """只读资源根目录。

    PyInstaller 6.x 的 onedir 会把 --add-data 的产物统一塞进 exe 旁的 _internal/，
    运行时该目录就是 sys._MEIPASS。
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    return Path(__file__).resolve().parent


APP_DIR = _app_dir()
RES_DIR = _resource_dir()
CONFIG_INI = APP_DIR / "config.ini"
LOG_FILE: Path | None = None


# ---------------------------------------------------------------- 基础设施

def _ensure_writable(path: Path) -> Path:
    """优先用 exe 旁的目录；没有写权限时（例如装在 Program Files）退到用户数据目录。"""
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-probe"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
        return path
    except OSError:
        fallback = Path(os.getenv("LOCALAPPDATA") or Path.home()) / "Janus" / path.name
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def _setup_logging() -> None:
    """--noconsole 下没有控制台，sys.stdout 是 None，任何 print/uvicorn 日志都会炸。

    统一重定向到日志文件，排障时直接看这个文件。
    """
    global LOG_FILE
    try:
        LOG_FILE = _ensure_writable(APP_DIR / "logs") / "janus.log"
        stream = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    except OSError:
        # 极端情况：连回退目录都建不出来，退化成丢弃输出，至少别让程序起不来
        LOG_FILE = None
        stream = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = stream
    sys.stderr = stream
    print(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 启动 Janus =====")


def _fatal(message: str) -> None:
    """弹窗告知失败原因——双击启动时用户看不到控制台。"""
    try:
        print(f"[FATAL] {message}")
    except Exception:
        pass
    if os.name == "nt":
        try:
            ctypes.windll.user32.MessageBoxW(None, message, "Janus 启动失败", 0x10)
        except Exception:
            pass


def _read_env_file(path: Path) -> dict:
    """极简 .env 解析，与 backend/config.py 的规则保持一致。"""
    out: dict = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _first_dir(*candidates: Path) -> Path:
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[0]


# ---------------------------------------------------------------- config.ini

def _ini_template(admin_token: str) -> str:
    return f"""; ============================================================
;  Janus 配置
;  本文件必须与 Janus.exe 放在同一目录；修改后重启程序生效。
;  格式为 INI：分号开头是注释，等号右边的值不要加引号。
; ============================================================

[server]
; HTTP 服务端口。该端口被别的程序占用时，会自动往后顺延找空闲端口。
port = 8000
; 监听地址：
;   127.0.0.1  仅本机可访问（默认，最安全）
;   0.0.0.0    允许局域网同事访问，需在 Windows 防火墙放行上面的端口
host = 127.0.0.1

[admin]
; 管理员口令，登录页「管理员」入口使用。
; 首次启动自动生成；留空 = 关闭管理员鉴权，任何人都能进管理页，共享环境请勿留空。
password = {admin_token}

[share]
; 「分享链接」基址，业务人员凭链接打开工作台。
; 留空则自动使用「本机局域网 IP + 下面的端口」。
public_base_url =
; 分享链接使用的端口。本地开发模式下指向 Vite 的 5173。
public_port = 5173

[log]
; 日志级别：debug / info / warning / error
level = info
"""


def _load_ini() -> configparser.ConfigParser:
    # interpolation=None：口令里若含 % 不会被当成插值语法而报错
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(CONFIG_INI, encoding="utf-8")
    return parser


def _ini_get(parser: configparser.ConfigParser, section: str, key: str, default: str = "") -> str:
    try:
        value = parser.get(section, key)
    except (configparser.NoSectionError, configparser.NoOptionError):
        return default
    return (value or "").strip()


def _seed_token() -> str:
    """首次生成 config.ini 时，先尝试从 exe 旁的 .env 迁移旧口令。"""
    external = _read_env_file(APP_DIR / ".env") or _read_env_file(RES_DIR / ".env")
    return external.get("CAP_ADMIN_TOKEN", "")


def _ensure_config_ini() -> bool:
    """config.ini 不存在就生成一份带注释的默认配置。返回是否新建。"""
    if CONFIG_INI.is_file():
        return False
    token = _seed_token() or f"janus-{secrets.token_hex(4)}"
    try:
        CONFIG_INI.write_text(_ini_template(token), encoding="utf-8")
    except OSError as exc:
        print(f"[WARN] 无法写入 {CONFIG_INI}：{exc}")
        return False
    return True


def _apply_ini(parser: configparser.ConfigParser) -> dict:
    """把 config.ini 的值落到 CONFIG 与环境变量上，返回摘要供日志打印。

    同时写进 os.environ 是为了让 backend.config 里 public_share_base() 这类
    运行时读环境变量的逻辑也能拿到（已存在的同名环境变量优先，不被覆盖）。
    """
    import backend.config as cfg

    def _set_env(name: str, value: str) -> None:
        if value and not (os.getenv(name) or "").strip():
            os.environ[name] = value

    raw_port = _ini_get(parser, "server", "port")
    host = _ini_get(parser, "server", "host") or "127.0.0.1"
    password = _ini_get(parser, "admin", "password")
    public_base = _ini_get(parser, "share", "public_base_url")
    public_port = _ini_get(parser, "share", "public_port")
    log_level = (_ini_get(parser, "log", "level") or "info").lower()

    if raw_port:
        try:
            cfg.CONFIG.port = int(raw_port)
        except ValueError:
            print(f"[WARN] config.ini 的 server.port 不是数字：{raw_port!r}，沿用 {cfg.CONFIG.port}")

    cfg.CONFIG.host = host
    # config.ini 是主配置：显式留空即视为关闭管理员鉴权，不再回退到 .env
    cfg.CONFIG.admin_token = password

    _set_env("CAP_ADMIN_TOKEN", password)
    _set_env("CAP_PUBLIC_BASE_URL", public_base)
    _set_env("CAP_PUBLIC_PORT", public_port)

    if public_port:
        try:
            cfg.CONFIG.frontend_port = int(public_port)
        except ValueError:
            print(f"[WARN] config.ini 的 share.public_port 不是数字：{public_port!r}")

    return {
        "host": host,
        "port": cfg.CONFIG.port,
        "log_level": log_level,
        "admin": "已配置" if password else "留空（管理员鉴权已关闭）",
        "public": public_base or "自动探测局域网 IP",
    }


def _apply_paths():
    """必须在 import backend.app 之前调用：backend.app 模块顶层会执行 _mount_web()。"""
    import backend.config as cfg

    # 前端资源：优先 exe 旁的 web/dist（方便单独替换前端），否则用打包进 _internal 的副本
    web_dist = _first_dir(APP_DIR / "web" / "dist", RES_DIR / "web" / "dist")
    cfg.CONFIG.web_dist = web_dist
    cfg.CONFIG.web_index_fallback = web_dist / "index.html"

    cfg.CONFIG.db_path = _ensure_writable(APP_DIR / "data") / "app.db"
    return cfg


# ---------------------------------------------------------------- 端口与单实例

def _port_free(port: int) -> bool:
    """回环与全网卡两种绑定都要试。

    只探测 127.0.0.1 会漏掉「别的服务占着 0.0.0.0:8000」这种情况——本地仍绑得上，
    但两个服务抢同一端口，局域网访问会打到别人身上。宁可换端口也别留这种歧义。
    """
    for host in ("127.0.0.1", "0.0.0.0"):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
            except OSError:
                return False
    return True


def _pick_port(preferred: int = 8000) -> int:
    """优先用配置里的端口，被占用就往后顺延；全占满则交给系统分配。"""
    for port in range(preferred, preferred + 50):
        if _port_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _acquire_single_instance() -> bool:
    """命名互斥体判重。返回 False 表示已有实例在跑。"""
    if os.name != "nt":
        return True
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW(None, False, MUTEX_NAME)
    return kernel32.GetLastError() != ERROR_ALREADY_EXISTS


def _focus_existing_window() -> None:
    """二次双击时把已有窗口拉回前台，而不是再起一个后端。"""
    if os.name != "nt":
        return
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, WINDOW_TITLE)
        if hwnd:
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
    except Exception:
        pass


def _wait_until_ready(port: int, timeout: float = SERVER_READY_TIMEOUT) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


# ---------------------------------------------------------------- 窗口

def _first_icon() -> Path | None:
    for c in (APP_DIR / "assets" / "janus.ico", RES_DIR / "assets" / "janus.ico"):
        if c.is_file():
            return c
    return None


def _open_window(url: str) -> None:
    import webview

    webview.create_window(
        WINDOW_TITLE,
        url,
        width=1440,
        height=920,
        min_size=(1024, 700),
    )
    icon = _first_icon()
    # pywebview 的 icon 参数只在 GTK/QT 生效；Windows 的窗口图标由 exe 自带图标继承
    if os.name != "nt" and icon is not None:
        webview.start(icon=str(icon))
    else:
        webview.start()


# ---------------------------------------------------------------- 主流程

def main() -> int:
    _setup_logging()

    if not _acquire_single_instance():
        _focus_existing_window()
        print("检测到已有实例在运行，已尝试唤起原窗口。")
        return 0

    created = _ensure_config_ini()
    summary = _apply_ini(_load_ini())
    cfg = _apply_paths()

    if created:
        print(f"已在 {CONFIG_INI} 生成默认配置（管理员口令为随机值，请按需修改）")
    print(f"配置文件 {CONFIG_INI}")
    print(f"资源目录 {RES_DIR}")
    print(f"数据目录 {cfg.CONFIG.db_path.parent}")
    print(f"监听地址 {summary['host']}；管理员口令 {summary['admin']}；分享基址 {summary['public']}")

    from backend.db import get_conn, init_db

    init_db(get_conn())

    port = _pick_port(summary["port"])
    if port != summary["port"]:
        print(f"[WARN] 配置端口 {summary['port']} 已被占用，改用 {port}（可在 config.ini 中固定）")
    url = f"http://127.0.0.1:{port}"
    if summary["host"] == "0.0.0.0":
        print("[提示] host=0.0.0.0：局域网可访问，若弹出防火墙提示请选择允许")
    print(f"服务地址 {url}")

    def _serve() -> None:
        import uvicorn

        from backend.app import app

        uvicorn.run(app, host=summary["host"], port=port, log_level=summary["log_level"])

    threading.Thread(target=_serve, name="janus-uvicorn", daemon=True).start()

    if not _wait_until_ready(port):
        where = LOG_FILE or "（日志不可用）"
        _fatal(
            f"后端服务未能在 {int(SERVER_READY_TIMEOUT)} 秒内启动。\n\n"
            f"请查看日志排查：\n{where}"
        )
        return 1

    _open_window(url)
    print("窗口已关闭，进程退出。")
    return 0


if __name__ == "__main__":
    if os.name == "nt":
        try:
            # 高 DPI 屏下 WebView 不糊
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        _fatal(f"程序发生未处理的错误：\n\n{traceback.format_exc()[-800:]}")
        sys.exit(1)
