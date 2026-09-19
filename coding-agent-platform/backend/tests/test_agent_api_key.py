"""Agent config.api_key 掩码返回与哨兵保留的测试。

GET /api/agents 业务令牌即可访问，config 里的 API Key 不能明文出后端：
列表一律掩码返回（API_KEY_MASK 哨兵），编辑保存时传回哨兵表示保留原 key。
这里直接调用路由函数验证掩码与哨兵语义（直调约定见 test_admin_edit.py）。
"""
from backend.db import get_conn, init_db
from backend import app as A
from backend.models import AgentCreate, AgentUpdate


def _conn():
    conn = get_conn()
    init_db(conn)
    return conn


def _raw_config(conn, aid) -> dict:
    """绕过掩码直接读库里的原始 config（验证落库值）。"""
    row = conn.execute("SELECT config FROM agents WHERE id=?", (aid,)).fetchone()
    import json
    return json.loads(row["config"])


def test_mask_config_masks_key_in_dict_and_string():
    import json
    assert A._mask_config({"model": "m", "api_key": "sk-secret"}) == \
        {"model": "m", "api_key": A.API_KEY_MASK}
    # 字符串形态保持字符串形态（与库里存储一致，不改变 API 的 config 类型）
    assert json.loads(A._mask_config('{"api_key":"sk-secret"}')) == {"api_key": A.API_KEY_MASK}
    # 无 key / 脏 JSON 原样（脏 JSON 回空 dict / 空对象）
    assert A._mask_config({"model": "m"}) == {"model": "m"}
    assert A._mask_config("not-json") == {}
    assert A._mask_config(None) == {}


def test_agents_enriched_masks_key_and_sets_flag():
    import json
    conn = _conn()
    a = A.create_agent(AgentCreate(name="a1", type="cursor",
                                   config={"api_key": "sk-secret", "model": "m"}), conn)
    assert a["has_api_key"] is True
    assert json.loads(a["config"])["api_key"] == A.API_KEY_MASK
    assert json.loads(a["config"])["model"] == "m"
    # 落库的是明文（子进程注入要用），返回视图才是掩码
    assert _raw_config(conn, a["id"])["api_key"] == "sk-secret"
    # 未配置 key 的 agent 无标记、无掩码键
    b = A.create_agent(AgentCreate(name="a2", type="cursor", config={"model": "m"}), conn)
    assert "has_api_key" not in b or b["has_api_key"] is False
    assert "api_key" not in b["config"]
    conn.close()


def test_update_sentinel_preserves_original_key():
    conn = _conn()
    a = A.create_agent(AgentCreate(name="a1", type="cursor", config={"api_key": "sk-old"}), conn)
    # 哨兵原样传回 → 保留原 key（编辑页不动 key 直接保存的场景）
    out = A.update_agent(a["id"], AgentUpdate(config={"api_key": A.API_KEY_MASK, "model": "m2"}), conn)
    assert A._config_of(out)["api_key"] == A.API_KEY_MASK
    assert _raw_config(conn, a["id"])["api_key"] == "sk-old"
    assert _raw_config(conn, a["id"])["model"] == "m2"
    conn.close()


def test_update_new_value_overwrites_and_empty_clears():
    conn = _conn()
    a = A.create_agent(AgentCreate(name="a1", type="cursor", config={"api_key": "sk-old"}), conn)
    # 新值覆盖
    A.update_agent(a["id"], AgentUpdate(config={"api_key": "sk-new"}), conn)
    assert _raw_config(conn, a["id"])["api_key"] == "sk-new"
    # 键缺省/空串即清除
    A.update_agent(a["id"], AgentUpdate(config={"model": "m"}), conn)
    assert "api_key" not in _raw_config(conn, a["id"])
    conn.close()


def test_create_with_sentinel_drops_key():
    """新建时哨兵无原值可保留，视为未配置（防呆）。"""
    conn = _conn()
    a = A.create_agent(AgentCreate(name="a1", type="cursor",
                                   config={"api_key": A.API_KEY_MASK}), conn)
    assert "api_key" not in _raw_config(conn, a["id"])
    conn.close()
