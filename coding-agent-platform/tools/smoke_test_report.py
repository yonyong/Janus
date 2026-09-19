"""测试报告同步接口 HTTP 冒烟：POST /api/requirements/{rid}/test-result/sync。

链路：Agent 把表格版测试报告写进工作区 .janus/{dir}/arch/test-result.md，
平台解析表格并回写 test_case.status，归档验收页的「X/N 条通过」才有数。
单测（test_test_report.py）覆盖解析规则，这里覆盖接口层：鉴权、文件缺失、
真实落库后的统计回读。

用法：coding-agent-platform/ 下执行
  python tools/smoke_test_report.py
"""
import os

import _smoke_common as S

REPORT = """# 免密登录 测试报告

| 用例 | 标题 | 结果 | 说明 |
| --- | --- | --- | --- |
| 01 | 正确密码可登录 | 通过 | 64ms |
| 02 | 错误密码提示 | 失败 | 未弹提示 |
| 03 | 隐身窗口无入口 | 通过 | |
"""

s = S.boot(port=8032)
call, check, ADMIN = s.call, s.check, s.admin

try:
    st, proj = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "tr", "disk_path": str(s.ws)})
    check("创建项目", st, 200)
    pid = proj["id"]
    st, tok = call("POST", f"/api/projects/{pid}/issue-token", {"admin": ADMIN}, {"project_ids": [pid]})
    tk = tok["token"]
    st, req = call("POST", f"/api/projects/{pid}/requirements", {"token": tk},
                   {"title": "免密登录", "description": ""})
    check("建需求", st, 200)
    rid = req["id"]
    dname = req["dir_name"]

    st, out = call("POST", f"/api/requirements/{rid}/cases/bulk", {"token": tk},
                   {"cases": [{"title": "正确密码可登录"}, {"title": "错误密码提示"},
                              {"title": "隐身窗口无入口"}]})
    check("预置 3 条用例", (st, out["created"]), (200, 3))

    # 报告还没写：found=False，200 不报错，状态全部保持 pending
    st, out = call("POST", f"/api/requirements/{rid}/test-result/sync", {"token": tk})
    check("报告缺失 200 且 found=False", (st, out["found"], out["updated"]), (200, False, 0))
    st, wf = call("GET", f"/api/requirements/{rid}/workflow", {"token": tk})
    check("同步前统计：全 pending", (wf["cases"]["total"], wf["cases"]["passed"], wf["cases"]["pending"]),
          (3, 0, 3))

    # Agent 写入表格版报告 → 同步 → 状态与统计回写
    report_abs = os.path.join(str(s.ws), ".janus", dname, "arch", "test-result.md")
    os.makedirs(os.path.dirname(report_abs), exist_ok=True)
    with open(report_abs, "w", encoding="utf-8") as f:
        f.write(REPORT)
    st, out = call("POST", f"/api/requirements/{rid}/test-result/sync", {"token": tk})
    check("同步成功：3 行全部回写", (st, out["found"], out["rows"], out["updated"]), (200, True, 3, 3))
    check("同步返回最新统计", (out["stats"]["passed"], out["stats"]["failed"]), (2, 1))
    st, wf = call("GET", f"/api/requirements/{rid}/workflow", {"token": tk})
    check("看板统计已刷新", (wf["cases"]["passed"], wf["cases"]["failed"], wf["cases"]["pending"]),
          (2, 1, 0))
    st, cases = call("GET", f"/api/requirements/{rid}/cases", {"token": tk})
    check("逐条状态回写", [c["status"] for c in cases], ["passed", "failed", "passed"])

    # 幂等：重复同步不再改动
    st, out = call("POST", f"/api/requirements/{rid}/test-result/sync", {"token": tk})
    check("重复同步 updated=0", (st, out["updated"]), (200, 0))

    # 报告改回纯文字：found=True 但解析不出结果，不回写也不清状态
    with open(report_abs, "w", encoding="utf-8") as f:
        f.write("结论：全部通过。")
    st, out = call("POST", f"/api/requirements/{rid}/test-result/sync", {"token": tk})
    check("纯文字报告不回写不清状态", (st, out["found"], out["updated"], out["stats"]["passed"]),
          (200, True, 0, 2))

    # 权限
    st, _ = call("POST", f"/api/requirements/{rid}/test-result/sync", {})
    check("无令牌 401", st, 401)
    st, p2 = call("POST", "/api/projects", {"admin": ADMIN}, {"name": "other", "disk_path": str(s.tmp)})
    st, t2 = call("POST", f"/api/projects/{p2['id']}/issue-token", {"admin": ADMIN},
                  {"project_ids": [p2["id"]]})
    st, _ = call("POST", f"/api/requirements/{rid}/test-result/sync", {"token": t2["token"]})
    check("越权令牌 403", st, 403)
finally:
    s.stop()

raise SystemExit(s.finish())
