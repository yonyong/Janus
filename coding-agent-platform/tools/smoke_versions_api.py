"""需求版本历史 + 工作区改动记录的 HTTP 冒烟。

这一层要验的东西单测覆盖不到：

1. 版本接口的鉴权走的是 `?token=` 查询参数（单测直接传 allowed，绕过了这段）；
2. 改动记录**必须由一次真实的 agent 运行产生** —— 平台是「运行前后各拍一张工作区
   快照再比对」，所以脚本里的桩 agent 会真的往工作区写文件 / 改文件 / 删文件，
   走完 session_service 里那条快照链路，而不是手工往库里塞行；
3. 回退真的落到磁盘上（且回退本身也记一条）。

用法：coding-agent-platform/ 下执行
  python tools/smoke_versions_api.py
"""
import os

import _smoke_common as S


class WritingAgentAdapter:
    """桩 agent：不调外部进程，但**真的改盘**，让快照链路有东西可比。"""

    type = "writer"

    async def invoke(self, agent_row, message, project_path):
        from backend.agent_runtime import AgentEvent

        yield AgentEvent(type="status", pane="message", text="开始改代码")
        with open(os.path.join(project_path, "added_by_agent.txt"), "w", encoding="utf-8") as f:
            f.write("这是 agent 新建的文件\n")
        with open(os.path.join(project_path, "src", "app.py"), "w", encoding="utf-8") as f:
            f.write("print('agent 改过了')\n")
        os.remove(os.path.join(project_path, "README.md"))
        yield AgentEvent(type="edit", pane="code", text="已新增 1 个、修改 1 个、删除 1 个文件")
        yield AgentEvent(type="message", pane="message", text="改完了")


s = S.boot(port=8023)
s.register_adapter(WritingAgentAdapter())
call, check, ADMIN = s.call, s.check, s.admin
ws = s.ws

try:
    st, proj = call("POST", "/api/projects", {"admin": ADMIN},
                    {"name": "ver", "disk_path": str(ws)})
    check("创建项目", st, 200)
    pid = proj["id"]
    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN},
                   {"project_ids": [pid]})
    tk = tok["token"]

    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "免密登录", "description": "用户希望免密登录"})
    check("建需求", st, 200)
    rid = req["id"]

    st, agent = call("POST", "/api/agents", {"admin": ADMIN},
                     {"name": "writer", "type": "writer", "config": {}})
    st, sess = call("POST", "/api/sessions", {"token": tk}, {"requirement_id": rid})
    sid = sess["id"]

    # ---------------- 需求文档版本历史 ----------------
    print("\n-- 需求文档历史版本 --")
    st, vs = call("GET", f"/api/requirements/{rid}/versions", {"token": tk})
    check("创建即留下第一个版本", (st, len(vs), vs[0]["source"], vs[0]["current"]), (200, 1, "create", True))

    st, _ = call("PATCH", f"/api/requirements/{rid}", {"token": tk},
                 {"description": "用户希望免密登录，减少输入密码", "source": "manual"})
    st, vs = call("GET", f"/api/requirements/{rid}/versions", {"token": tk})
    check("保存后多一版且新版在前", (len(vs), vs[0]["source"], vs[0]["current"], vs[1]["current"]),
          (2, "manual", True, False))

    st, _ = call("PATCH", f"/api/requirements/{rid}", {"token": tk},
                 {"description": "AI 润色后的文档", "source": "ai"})
    st, vs = call("GET", f"/api/requirements/{rid}/versions", {"token": tk})
    check("AI 润色来源被记录", (len(vs), vs[0]["source"]), (3, "ai"))

    st, _ = call("PATCH", f"/api/requirements/{rid}", {"token": tk},
                 {"description": "AI 润色后的文档"})
    st, vs = call("GET", f"/api/requirements/{rid}/versions", {"token": tk})
    check("内容没变不重复记版本", len(vs), 3)

    st, _ = call("PATCH", f"/api/requirements/{rid}", {"token": tk}, {"description": "hack", "source": "hacker"})
    st, vs = call("GET", f"/api/requirements/{rid}/versions", {"token": tk})
    check("非法来源回退为 manual", vs[0]["source"], "manual")

    first_vid = vs[-1]["id"]
    st, old = call("GET", f"/api/requirements/{rid}/versions/{first_vid}", {"token": tk})
    check("读单个版本正文", (st, old["description"]), (200, "用户希望免密登录"))

    st, out = call("POST", f"/api/requirements/{rid}/versions/{first_vid}/restore", {"token": tk})
    check("回退到首版", (st, out["description"]), (200, "用户希望免密登录"))
    st, vs = call("GET", f"/api/requirements/{rid}/versions", {"token": tk})
    check("回退本身也记一版", (vs[0]["source"], "回退到版本" in vs[0]["note"]), ("revert", True))

    st, out = call("GET", f"/api/requirements/{rid}/workflow", {"token": tk})
    check("需求内容确已回退", out["requirement"]["description"], "用户希望免密登录")
    check("看板带版本数", (st, out["versions"] >= 5), (200, True))

    # 跨需求读版本应 404
    st, req2 = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                    {"title": "另一个需求", "description": "别的"})
    st, _ = call("GET", f"/api/requirements/{req2['id']}/versions/{first_vid}", {"token": tk})
    check("跨需求读版本 404", st, 404)
    st, _ = call("POST", f"/api/requirements/{rid}/versions/999999/restore", {"token": tk})
    check("回退不存在的版本 404", st, 404)

    # ---------------- 工作区改动记录（真跑一次 agent） ----------------
    print("\n-- 工作区改动记录 --")
    st, out = call("GET", f"/api/projects/{pid}/changesets", {"token": tk, "session_id": sid})
    check("跑之前没有记录", (st, out), (200, []))

    events = s.stream_run(sid, "帮我改一下代码", token=tk)
    check("agent 跑完收到 done", any(e.get("type") == "done" for e in events), True)

    st, sets = call("GET", f"/api/projects/{pid}/changesets", {"token": tk, "session_id": sid})
    check("跑完落了一条改动记录", (st, len(sets)), (200, 1))
    cs = sets[0]
    check("改动统计：一增一改一删", (cs["added"], cs["modified"], cs["removed"], cs["file_count"]),
          (1, 1, 1, 3))
    check("记录来源为 agent", cs["source"], "agent")
    check("列表项带文件预览", sorted(f["path"] for f in cs["preview"]),
          ["README.md", "added_by_agent.txt", "src/app.py"])
    csid = cs["id"]

    st, detail = call("GET", f"/api/changesets/{csid}", {"token": tk})
    check("明细 3 个文件", (st, len(detail["files"])), (200, 3))
    by_path = {f["path"]: f for f in detail["files"]}
    check("新增文件可回退", by_path["added_by_agent.txt"]["revertible"], True)
    check("修改文件带逐行 diff", "+print('agent 改过了')" in by_path["src/app.py"]["diff"], True)
    check("删除文件 diff 为负行", "-" in by_path["README.md"]["diff"], True)

    st, allsets = call("GET", f"/api/projects/{pid}/changesets", {"token": tk})
    check("不带 session_id 也能按项目列", (st, len(allsets)), (200, 1))

    # ---------------- 单文件回退 ----------------
    st, out = call("POST", f"/api/changesets/{csid}/files/{by_path['src/app.py']['id']}/revert",
                   {"token": tk})
    check("单文件回退成功", (st, out["ok"], out["reverted"], out["skipped"]), (200, True, 1, 0))
    check("文件内容已还原", open(ws / "src" / "app.py", encoding="utf-8").read(), "print('hi')\n")
    check("其余文件不受影响", os.path.exists(ws / "added_by_agent.txt"), True)
    check("回退本身也记一条记录", (out["change_set"]["source"], out["change_set"]["modified"]),
          ("revert", 1))

    # ---------------- 整条回退 ----------------
    st, out = call("POST", f"/api/changesets/{csid}/revert", {"token": tk})
    # 三个文件都回退（app.py 已被单独回退过一次，再写一次同样的内容仍然算成功）
    check("整条回退成功", (st, out["ok"], out["reverted"], out["skipped"]), (200, True, 3, 0))
    check("新增的文件被删掉", os.path.exists(ws / "added_by_agent.txt"), False)
    check("被删的文件被找回", open(ws / "README.md", encoding="utf-8").read(), "# hi\n")

    st, sets2 = call("GET", f"/api/projects/{pid}/changesets", {"token": tk, "session_id": sid})
    check("原记录保留 + 新增回退记录", len(sets2), 3)

    # 回退记录自身也能再回退（历史里没有黑洞）
    rev = [x for x in sets2 if x["source"] == "revert"][-1]
    st, out = call("POST", f"/api/changesets/{rev['id']}/revert", {"token": tk})
    check("回退记录可再回退", (st, out["ok"], out["reverted"] >= 1), (200, True, True))

    # ---------------- 边界与权限 ----------------
    print("\n-- 边界与权限 --")
    st, _ = call("GET", f"/api/changesets/999999", {"token": tk})
    check("不存在的改动记录 404", st, 404)

    st, cs_empty = call("GET", f"/api/projects/{pid}/changesets", {"token": tk})
    empty_id = None
    for x in cs_empty:
        st, d = call("GET", f"/api/changesets/{x['id']}", {"token": tk})
        if not d["files"]:
            empty_id = x["id"]
            break
    if empty_id:
        st, _ = call("POST", f"/api/changesets/{empty_id}/revert", {"token": tk})
        check("空记录回退 400", st, 400)

    st, _ = call("GET", f"/api/requirements/{rid}/versions", {})
    check("版本接口无令牌 401", st, 401)
    st, _ = call("GET", f"/api/projects/{pid}/changesets", {})
    check("改动记录无令牌 401", st, 401)

    st, proj2 = call("POST", "/api/projects", {"admin": ADMIN},
                     {"name": "other", "disk_path": str(s.tmp)})
    st, tok2 = call("POST", f"/api/projects/{proj2['id']}/issue-token", {"admin": ADMIN},
                    {"project_ids": [proj2["id"]]})
    other = tok2["token"]
    st, _ = call("GET", f"/api/requirements/{rid}/versions", {"token": other})
    check("版本接口越权 403", st, 403)
    st, _ = call("GET", f"/api/projects/{pid}/changesets", {"token": other})
    check("改动记录越权 403", st, 403)
    st, _ = call("GET", f"/api/changesets/{csid}", {"token": other})
    check("改动明细越权 403", st, 403)
    st, _ = call("POST", f"/api/changesets/{csid}/revert", {"token": other})
    check("越权回退 403", st, 403)
finally:
    s.stop()

raise SystemExit(s.finish())
