/**
 * 移动端适配一次性探针：390×844 手机视口下截图并断言「无横向溢出」。
 * 用法: node tools/ui_shot_mobile.mjs <基地址> <管理员口令>
 * 产出 .ui-smoke/mobile-1-login.png / mobile-2-dashboard.png / mobile-3-projects.png
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '')
const ADMIN_PWD = process.argv[3]
if (!ADMIN_PWD) {
  console.error('用法: node tools/ui_shot_mobile.mjs <基地址> <管理员口令>')
  process.exit(2)
}
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))
if (!CHROME) { console.error('未找到 Chrome/Edge'); process.exit(3) }

const PORT = 9336 + (process.pid % 400)
const PROFILE = join(tmpdir(), `cap-mobile-shot-${Date.now()}`)
const OUT_DIR = join(process.cwd(), '.ui-smoke')
mkdirSync(OUT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  // 直接用窗口尺寸模拟手机视口；配合 Emulation 覆盖会因 headless 最小窗宽产生布局与截图不一致
  '--window-size=390,844', `${BASE}/`,
], { stdio: 'ignore' })

let ws, seq = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)) } }, 30000)
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
async function shot(name) {
  await sleep(700)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, name)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`截图 → ${file}`)
}
const overflow = `(() => {
  const d = document.documentElement
  return JSON.stringify({ sw: d.scrollWidth, iw: window.innerWidth, sh: d.scrollHeight, ih: window.innerHeight })
})()`
const report = (label, o) => {
  // 只判横向溢出；纵向可滚动是正常内容行为
  const bad = o.sw > o.iw + 1
  console.log(`${bad ? '✗' : '✓'} ${label} scroll=${o.sw}x${o.sh} viewport=${o.iw}x${o.ih}${bad ? ' ← 横向溢出' : ''}`)
}

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch { /* Chrome 还没起来 */ }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error('无法连接 Chrome 调试端口')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    const p = pending.get(m.id)
    if (p) { pending.delete(m.id); p.resolve(m) }
  })

  await send('Page.enable')
  await send('Runtime.enable')

  // 1) 未登录：登录弹框在手机视口的表现
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector('.ant-modal')`)) break
    await sleep(300)
  }
  await sleep(800)
  report('登录弹框', JSON.parse(await evaluate(overflow)))
  await shot('mobile-1-login.png')

  // 2) 注入管理员登录态，看工作台 Dashboard（必须整页 reload，hash 导航不会重读登录态）
  await evaluate(`localStorage.setItem('cap_admin_token', ${JSON.stringify(ADMIN_PWD)}); localStorage.removeItem('cap_access_token'); 'ok'`)
  await send('Page.reload', { ignoreCache: false })
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector('.hero')`)) break
    await sleep(300)
  }
  await sleep(800)
  const checks = await evaluate(`(() => {
    const sider = document.querySelector('.ant-layout-sider')
    const search = document.querySelector('.global-search')
    const content = document.querySelector('.app-content')
    return JSON.stringify({
      siderCollapsed: sider ? sider.classList.contains('ant-layout-sider-collapsed') : null,
      searchHidden: search ? getComputedStyle(search).display === 'none' : null,
      contentPadding: content ? getComputedStyle(content).paddingLeft : null,
    })
  })()`)
  console.log('布局断言:', checks)
  report('工作台 Dashboard', JSON.parse(await evaluate(overflow)))
  await shot('mobile-2-dashboard.png')

  // 3) 项目空间
  await send('Page.navigate', { url: `${BASE}/#/projects` })
  await sleep(1800)
  report('项目空间', JSON.parse(await evaluate(overflow)))
  await shot('mobile-3-projects.png')

  console.log('移动端探针完成 ✅')
} catch (e) {
  console.error('探针失败:', e.message)
  process.exitCode = 1
} finally {
  try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }) } catch { /* 进程可能已退出 */ }
}
