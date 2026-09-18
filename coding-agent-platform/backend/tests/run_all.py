"""无 pytest 环境下运行测试：
   python backend/tests/run_all.py
（若已 pip install pytest，也可直接 pytest backend/tests）。
"""
import importlib
import inspect
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # coding-agent-platform/
sys.path.insert(0, str(ROOT))

# 使用临时数据库，避免污染运行时 app.db
from backend import config as _config

_tmp = Path(tempfile.mkdtemp()) / "test.db"
_config.CONFIG.db_path = _tmp

TEST_DIR = Path(__file__).resolve().parent


def main():
    # 预注册两个适配器，模拟应用启动
    from backend.agent_runtime import AgentRegistry
    from backend.adapters.fake import FakeAgentAdapter
    from backend.adapters.codebuddy import CodeBuddyAdapter
    AgentRegistry.register("fake", FakeAgentAdapter())
    AgentRegistry.register("codebuddy", CodeBuddyAdapter())

    failed = 0
    total = 0
    for f in sorted(TEST_DIR.glob("test_*.py")):
        mod = importlib.import_module(f"backend.tests.{f.stem}")
        for name, fn in inspect.getmembers(mod, inspect.isfunction):
            if name.startswith("test_") and name != "test_":
                total += 1
                # 每个测试独立临时库，避免跨测试数据污染
                _config.CONFIG.db_path = Path(tempfile.mkdtemp()) / "t.db"
                try:
                    fn()
                    print(f"  PASS  {f.stem}.{name}")
                except Exception as e:  # noqa: BLE001
                    failed += 1
                    print(f"  FAIL  {f.stem}.{name}: {e}")
    print(f"\n{total - failed}/{total} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
