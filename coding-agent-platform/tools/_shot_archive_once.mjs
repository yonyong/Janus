/**
 * 一次性截图：管理员打开工作台「归档」分类，核对归档页（提示条 / 测试报告卡）真实渲染效果。
 * 用法：node tools/_shot_archive_once.mjs http://127.0.0.1:8123 <管理员口令> <会话id> [输出文件]
 * 产出：默认 .ui-smoke/archive-tab.png
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '')
const ADMIN_PWD = process.argv[3]
const SID = process.argv[4] || '1'
const OUT = process.argv[5] || join(process.cwd(), '.ui-smoke', 'archive-tab.png')
if (!ADMIN_PWD) {
  console.error('用法: node tools/_shot_archive_once.mjs <基地址> <管理员口令> [会话id] [输出文件]')
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
const PROFILE = join(tmpdir(), `cap-archive-shot-${Date.now()}`)
mkdirSync(join(OUT, '..'), { recursive: true })

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
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.removeItem('cap_access_token'); localStorage.setItem('cap_admin_token', ${JSON.stringify(ADMIN_PWD)}); } catch (e) {}`,
  })

  await send('Page.navigate', { url: `${BASE}/?ui=${Date.now()}#/workbench/${SID}` })
  await sleep(3000)

  // 切到左栏「归档」分类
  const clicked = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.wfa-rail-item')].find(e => (e.textContent || '').includes('归档'))
    if (!el) return false
    el.click()
    return true
  })()`)
  console.log(`点击「归档」分类：${clicked}`)
  await sleep(1500)

  // 可选：往 DOM 里插一条「已归档」样式的提示条（只改页面 DOM，不动数据），核对另一种配色
  if (process.argv[6] === 'inject') {
    const injected = await evaluate(`(() => {
      const n = document.querySelector('.arc-notice')
      if (!n) return false
      const c = n.cloneNode(true)
      c.className = 'arc-notice arc-notice-ok'
      const t = c.querySelector('.arc-notice-title')
      if (t) t.innerHTML = '需求已完成<span class="arc-notice-time">2026-09-21 23:05:00</span>'
      const d = c.querySelector('.arc-notice-desc')
      if (d) d.textContent = '验收结论：三条用例全部通过，遗留的埋点校验放到下个需求跟进。'
      n.after(c)
      return true
    })()`)
    console.log(`注入已归档提示条：${injected}`)
    await sleep(400)
  }

  const info = await evaluate(`JSON.stringify({
    notice: (document.querySelector('.arc-notice') || {}).textContent || '',
    head: (document.querySelector('.arc-card-head') || {}).textContent || '',
    box: (() => { const n = document.querySelector('.arc-notice'); if (!n) return null; const r = n.getBoundingClientRect(); const c = document.querySelector('.arc-card')?.getBoundingClientRect(); return { noticeLeft: Math.round(r.left), noticeRight: Math.round(r.right), noticeH: Math.round(r.height), cardLeft: c ? Math.round(c.left) : null, cardRight: c ? Math.round(c.right) : null } })(),
    errs: window.__errs || 0
  })`)
  console.log(info)

  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT, Buffer.from(r.result.data, 'base64'))
  console.log(`截图 → ${OUT}`)
} finally {
  cleanup()
}
