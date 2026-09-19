/**
 * 接口并发冒烟测试（Node 18+，无需依赖）。
 *
 * 用途：验证「一次页面加载并发打多个接口」时后端不 500。
 * 背景：FastAPI 的同步依赖与同步路由跑在线程池的不同工作线程上，
 *      sqlite3 连接若未关闭线程校验（check_same_thread=False），
 *      并发请求会偶发 ProgrammingError -> 500。
 *
 * 用法（先启动后端）：
 *   node tools/loadtest_api.mjs [轮数] [admin口令] [分享令牌]
 * 例：
 *   node tools/loadtest_api.mjs 5 janus-admin-xxxx MQddZzKL...
 *
 * 退出码非 0 表示存在非 200 响应，可直接接入 CI。
 */
const rounds = Number(process.argv[2] || 5)
const admin = process.argv[3] || process.env.CAP_ADMIN_TOKEN || ''
const share = process.argv[4] || process.env.CAP_SHARE_TOKEN || ''
const base = process.env.CAP_BASE || 'http://localhost:8000'

async function hit(path, params) {
  const u = new URL(path, base)
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v) u.searchParams.set(k, v)
  })
  try {
    const r = await fetch(u)
    const t = await r.text()
    return { p: u.pathname, status: r.status, ct: r.headers.get('content-type') || '', body: t.slice(0, 100) }
  } catch (e) {
    return { p: u.pathname, status: 0, ct: '', body: String(e.message) }
  }
}

function plan() {
  const calls = [hit('/api/agents'), hit('/api/admin/state')]
  if (admin) {
    calls.push(
      hit('/api/admin/overview', { admin }),
      hit('/api/admin/projects', { admin }),
      hit('/api/admin/tokens', { admin }),
      hit('/api/admin/sessions', { admin }),
    )
  }
  if (share) {
    calls.push(
      hit('/api/projects', { token: share }),
      hit('/api/projects/1/requirements', { token: share }),
      hit('/api/projects/2/requirements', { token: share }),
    )
  }
  return calls
}

let ok = 0
let bad = 0
for (let i = 0; i < rounds; i++) {
  const out = await Promise.all(plan())
  console.log(`round ${i + 1}: ${out.map((r) => `${r.p.replace('/api/', '')}=${r.status}`).join(' ')}`)
  for (const r of out) {
    if (r.status === 200) ok++
    else {
      bad++
      console.log('   !! ', r.status, r.ct, r.body.replace(/\n/g, ' '))
    }
  }
}
console.log(`\nok=${ok} fail=${bad}`)
process.exit(bad ? 1 : 0)
