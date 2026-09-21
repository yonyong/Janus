"""为打包产物在 exe 同级生成 config.ini（已存在则跳过，不会覆盖用户改动）。

由 pack.bat 在打包结束后调用：python tools/make_config_ini.py dist/Janus

生成逻辑复用 pack_launch 里的模板与随机口令，保证与运行时首启生成的结果完全一致。
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pack_launch as pl  # noqa: E402  必须在 sys.path 调整之后导入


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python tools/make_config_ini.py <打包产物目录，如 dist/Janus>")
        return 2

    target_dir = pathlib.Path(sys.argv[1]).resolve()
    if not target_dir.is_dir():
        print(f"[跳过] 目录不存在：{target_dir}")
        return 1

    # 指向产物目录，_ensure_config_ini 会读该目录下的 .env 作为旧口令来源
    pl.CONFIG_INI = target_dir / "config.ini"
    if pl._ensure_config_ini():
        print(f"已生成 {pl.CONFIG_INI}（管理员口令为随机值，发布前请确认）")
    else:
        print(f"已存在 {pl.CONFIG_INI}，保持原样不覆盖")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
