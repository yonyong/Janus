/**
 * 一次性截图：管理员打开「Agent 管理」页，验证飞书风格改版真实渲染效果。
 * 用法：node tools/_shot_agents_once.mjs http://127.0.0.1:8000 <管理员口令>
 * 产出：.ui-smoke/agents-redesign.png
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '')
const ADMIN_PWD = process.argv[3]
if (!ADMIN_PWD) {
  console.error('用法: node tools/_shot_agents_once.mjs <基地址> <管理员口令>')
  process.exit(2)
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!CHROME) {
  console.error('未找到 Chrome / Edge')
  process.exit(3)
}

const PORT = 9536 + (process.pid % 300)
const PROFILE = join(tmpdir(), `cap-agents-shot-${Date.now()}`)
const OUT_DIR = join(process.cwd(), '.ui-smoke')
mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pending = new Map()
let msgId = 0
let ws

function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP 超时: ${method}`))
      }
    }, 30000)
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const cleanup = () => {
  try {
    if (ws) ws.close()
  } catch {}
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(chrome.pid)], { stdio: 'ignore' })
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(1))

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {}
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
    try {
      m = JSON.parse(ev.data)
    } catch {
      return
    }
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      p.resolve(m)
    }
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  // 每次新文档加载前写入管理员登录态（cap_admin_token = 管理员口令）
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.removeItem('cap_access_token'); localStorage.setItem('cap_admin_token', ${JSON.stringify(ADMIN_PWD)}); } catch (e) {}`,
  })

  await send('Page.navigate', { url: `${BASE}/?ui=${Date.now()}#/agents` })
  await sleep(2500)

  const rows = await evaluate(`document.querySelectorAll('.ag-row').length`)
  const stats = await evaluate(`document.querySelectorAll('.ag-stat').length`)
  const name = await evaluate(`(document.querySelector('.ag-name') || {}).textContent || ''`)
  const errCount = await evaluate(`window.__errs || 0`)
  console.log(`指标卡 ${stats} 张，Agent 行 ${rows} 行，首行 ${name}`)

  await sleep(500)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, 'agents-redesign.png')
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`截图 → ${file}`)
  if (!stats || !rows) process.exit(1)
} finally {
  cleanup()
}
