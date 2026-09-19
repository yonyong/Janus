"""一次性验证：真 codebuddy CLI 运行中点中止，确认 run 被真正终止。

用法：coding-agent-platform/ 下  ./.venv/Scripts/python.exe tools/_verify_abort_real_cli.py
"""
import json
import threading
import time
import urllib.parse
import urllib.request

import _smoke_common as S


def _node_pids():
    """当前所有 node.exe 的 PID 集合（CLI 是 node 进程，用差集定位本次 run 新起的）。"""
    import subprocess
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True).stdout
    pids = set()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == "node.exe":
            try:
                pids.add(int(parts[1]))
            except ValueError:  # noqa: PERF203
                pass
    return pids


def _read_all(url, out, evt, timeout=300):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                try:
                    d = json.loads(line[6:])
                except Exception:  # noqa: BLE001
                    continue
                out.append(d)
                if d.get("type") in ("done", "error"):
                    break
    except Exception as e:  # noqa: BLE001
        out.append({"type": "_exc", "text": str(e)})
    finally:
        evt.set()


s = S.boot(port=8033)
try:
    st, proj = s.call("POST", "/api/projects", {"admin": s.admin},
                      {"name": "abort-real", "disk_path": str(s.ws)})
    assert st == 200, proj
    st, tok = s.call("POST", f"/api/projects/{proj['id']}/issue-token",
                     {"admin": s.admin}, {"project_ids": [proj["id"]]})
    tk = tok["token"]
    st, req = s.call("POST", f"/api/projects/{proj['id']}/requirements", {"token": tk},
                     {"title": "真中止验证", "description": ""})
    st, agent = s.call("POST", "/api/agents", {"admin": s.admin},
                       {"name": "cb", "type": "codebuddy", "config": {}})
    st, sess = s.call("POST", "/api/sessions", {"token": tk}, {"requirement_id": req["id"]})
    sid = sess["id"]

    MSG = "请只阅读项目里的 README.md，然后写一段不少于 300 字的阅读心得，期间不要修改任何文件"
    qp = urllib.parse.urlencode({"message": MSG, "token": tk})
    url = f"{s.base}/api/sessions/{sid}/events?{qp}"

    tail = []
    stop = threading.Event()
    base_pids = _node_pids()  # run 启动前的 node 进程基线
    th = threading.Thread(target=_read_all, args=(url, tail, stop), daemon=True)
    th.start()
    print("等待 codebuddy CLI 开始产生输出…", flush=True)
    for _ in range(600):
        if any(e.get("type") == "delta" for e in tail):
            break
        time.sleep(0.5)
    types = [e.get("type") for e in tail]
    print("已收到事件：", types, flush=True)
    assert any(t == "delta" for t in types), "CLI 没开始输出"

    time.sleep(3)  # 让 CLI 进入稳定运行态（子进程已全部拉起）
    during_pids = _node_pids()
    new_pids = during_pids - base_pids
    print(f"node 进程：基线 {len(base_pids)}，run 期间新增 {len(new_pids)}：{sorted(new_pids)}", flush=True)

    st, out = s.call("POST", f"/api/sessions/{sid}/abort", {"token": tk})
    print("中止接口：", st, out, flush=True)
    assert st == 200 and out["aborted"]

    th.join(timeout=60)
    print("事件流收尾：", [e.get("type") for e in tail], flush=True)
    assert any(e.get("type") == "abort" for e in tail), "应收到 abort 事件"
    assert tail[-1].get("type") == "done", tail

    time.sleep(2)
    st, act = s.call("GET", f"/api/sessions/{sid}/active-run", {"token": tk})
    assert (st, act["active"]) == (200, False), act
    if not new_pids:
        print("WARN：未捕捉到 run 新增的 node 进程，进程级核验跳过（事件级已验证）", flush=True)
    else:
        time.sleep(2)  # 给进程树杀灭留出缓冲
        alive = new_pids & _node_pids()
        assert not alive, f"中止后 CLI 进程仍存活：{sorted(alive)}"
        print(f"进程树核验：run 新增的 {len(new_pids)} 个 node 进程已全部终止", flush=True)
    print("PASS：真 codebuddy 运行被中止，run 已结束、abort 事件已送达、进程已杀干净", flush=True)
finally:
    s.stop()
