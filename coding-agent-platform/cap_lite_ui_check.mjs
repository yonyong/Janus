/**
 * 一次性检查：轻量工作流（mode=lite）的 UI 端到端验证。
 * 用法：node cap_lite_ui_check.mjs "<带 token 的工作台 URL（lite 会话）>"
 */
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ARG = process.argv[2]
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p))
const PORT = 9410
const PROFILE = join(tmpdir(), `cap-lite-check-${Date.now()}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = []
const fail = (m) => { fails.push(m); console.log('  ✗ ' + m) }
const ok = (m) => console.log('  ✓ ' + m)

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900',
  URL_ARG,
], { stdio: 'ignore' })

let ws
let seq = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')) } }, 30000)
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(process.cwd(), '.ui-smoke', name)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log('  截图 → ' + file)
}
async function waitFor(expr, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await evaluate(expr)) { ok(label); return true }
    if (Date.now() > deadline) { fail('等待超时：' + label); return false }
    await sleep(250)
  }
}

try {
  // 等 CDP 就绪并接到页面 target
  let targets = null
  for (let i = 0; i < 50 && !targets; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`)
      targets = await res.json()
    } catch { await sleep(300) }
  }
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m) }
  })
  await send('Page.enable')
  await sleep(2500)

  if (!(await waitFor(`!!document.querySelector('.wb-lite-steps')`, '轻量步骤条渲染'))) {
    throw new Error('轻量步骤条未出现')
  }
  const txt = await evaluate(`document.querySelector('.wb-lite-steps').textContent`)
  for (const expect of ['定义', '可选', '编码实现', '归档验收', '补做澄清', '补配用例', '未启用']) {
    if (txt.includes(expect)) ok(`包含「${expect}」`)
    else fail(`缺少「${expect}」`)
  }
  await shot('lite-1-steps.png')

  // 点「补配用例」应切到用例配置面板
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.wb-lite-pills button')]
      .find(e => e.textContent.includes('补配用例'))
    if (!b) return 'not-found'
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  await waitFor(`!!document.querySelector('.case-pane')`, '点补配用例后进入用例配置')
  await shot('lite-2-verify.png')

  // 切回编码实现，再直接点归档：应看到弱提示 Alert 且可标记完成
  await evaluate(`(() => {
    const n = [...document.querySelectorAll('.wb-lite-node')]
      .find(e => e.textContent.includes('编码实现'))
    n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  await waitFor(`!!document.querySelector('.wb-tabs')`, '回到编码实现')
  await evaluate(`(() => {
    const n = [...document.querySelectorAll('.wb-lite-node')]
      .find(e => e.textContent.includes('归档验收'))
    n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  await waitFor(`!!document.querySelector('.arc-card')`, '归档页渲染')
  const warn = await evaluate(
    `[...document.querySelectorAll('.arc-scroll .ant-alert-warning')].map(e => e.textContent).join('|')`)
  if (warn.includes('未配置用例') && warn.includes('改动记录')) ok('归档弱提示出现：' + warn.slice(0, 60) + '…')
  else fail('归档弱提示缺失：' + warn)
  const canArchive = await evaluate(
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('标记需求已完成') && !b.disabled)`)
  if (canArchive) ok('归档按钮可用（未阻断）')
  else fail('归档按钮不可用（被阻断了）')
  await shot('lite-3-archive.png')

  console.log(fails.length ? `轻量 UI 检查失败 ${fails.length} 项` : '轻量 UI 检查完成 ✅')
  process.exitCode = fails.length ? 1 : 0
} catch (e) {
  console.error('检查异常：' + e.message)
  process.exitCode = 1
} finally {
  try { chrome.kill() } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}
}
