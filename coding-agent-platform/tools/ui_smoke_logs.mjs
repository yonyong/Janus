/**
 * 实时日志 UI 冒烟：用本机 Chrome/Edge（headless + CDP）真实走一遍「/logs」页。
 *
 * 覆盖的不变式（都是需求里明确要求或只有浏览器里才能验证的）：
 *   1. 侧栏有「实时日志」入口，点进去能渲染出日志
 *   2. 列表一行一条：任何一行的高度都不超过单行高度（这是「不要出现换行」的硬性体现）
 *   3. 长文本被横向省略号收尾，而不是撑成多行；点这一行才展开全文，再点收起
 *   4. 级别 / 来源 / 关键词筛选立即生效，筛空时给出空态
 *   5. 真·实时：不刷新页面，外部触发的操作会自动出现在列表里（连接状态为「实时接收中」）
 *   6. 暂停只冻结屏幕、不丢数据：暂停期间不新增行，恢复后一条不落
 *   7. 清屏只清本地显示，连接不断
 *
 * 用法（需要后端已在跑）：
 *   node tools/ui_smoke_logs.mjs <基地址> <管理员口令> [输出目录]
 * 例：
 *   node tools/ui_smoke_logs.mjs http://127.0.0.1:8000 janus-admin-3ead5e
 *
 * 产出（默认 .ui-smoke/）：logs-1-list.png logs-2-filter.png logs-3-expanded.png
 *   logs-4-realtime.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '')
const ADMIN_PWD = process.argv[3]
const OUT_DIR = process.argv[4] || join(process.cwd(), '.ui-smoke')
if (!ADMIN_PWD) {
  console.error('用法: node tools/ui_smoke_logs.mjs <基地址> <管理员口令> [输出目录]')
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
  console.error('未找到 Chrome / Edge，跳过 UI 冒烟')
  process.exit(3)
}

const PORT = 9336
const PROFILE = join(tmpdir(), `cap-logs-smoke-${Date.now()}`)
const WS = mkdtempSync(join(tmpdir(), 'cap-logs-ws-'))
mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = []
const fail = (msg) => {
  fails.push(msg)
  console.log(`  ✗ ${msg}`)
}
const ok = (msg) => console.log(`  ✓ ${msg}`)
const expect = (cond, msg) => {
  if (cond) ok(msg)
  else fail(msg)
  return cond
}

/** 单行行高上限：padding 3+3 + line-height(12×1.6≈19) ≈ 25；两行就会到 ~44。 */
const SINGLE_LINE_MAX = 34

// ---------------- 准备数据：一个只含该项目的令牌 + 一条超长标题的需求 ----------------
const STAMP = Date.now()
const LONG_TITLE = `LONG-${STAMP}-` + '很长的需求标题用来验证列表不换行'.repeat(12)
let pid = null
let tk = null
let rid = null

async function adminCall(method, path, body) {
  const res = await fetch(`${BASE}${path}?admin=${encodeURIComponent(ADMIN_PWD)}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应：保留原始文本供排查 */
  }
  return { status: res.status, json, text }
}

try {
  const p = await adminCall('POST', '/api/projects', { name: `日志冒烟-${STAMP}`, disk_path: WS })
  if (p.status !== 200) throw new Error(`创建冒烟项目失败：${p.status} ${p.text.slice(0, 120)}`)
  pid = p.json.id
  const t = await adminCall('POST', `/api/projects/${pid}/issue-token`, { project_ids: [pid] })
  tk = t.json.token
  const r1 = await fetch(`${BASE}/api/projects/${pid}/requirements?token=${encodeURIComponent(tk)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: LONG_TITLE, description: '超长标题用于验证单行省略' }),
  })
  rid = (await r1.json()).id
  console.log(`冒烟项目 #${pid}，需求 #${rid}，令牌 ${tk.slice(0, 8)}…`)
} catch (e) {
  console.error(`准备冒烟数据失败：${e.message}`)
  process.exit(1)
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    `${BASE}/`,
  ],
  { stdio: 'ignore' },
)

let ws
let seq = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`${method} 超时`))
      }
    }, 30000)
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  const ex = r.result?.exceptionDetails
  if (ex) {
    throw new Error(`${ex.exception?.description || ex.text || 'Runtime.evaluate 异常'}\n  表达式: ${expression.slice(0, 300)}`)
  }
  return r.result?.result?.value
}

async function shot(name) {
  await sleep(500)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT_DIR, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  截图 → ${join(OUT_DIR, name)}`)
}

async function waitFor(expr, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let v = false
    try {
      v = await evaluate(expr)
    } catch {
      /* 页面切换中可能短暂报错 */
    }
    if (v) {
      ok(label)
      return true
    }
    if (Date.now() > deadline) {
      fail(`等待超时：${label}`)
      return false
    }
    await sleep(200)
  }
}

const QUERY = (sel) => `document.querySelector(${JSON.stringify(sel)})`
const ROW_BY_TEXT = (needle) =>
  `[...document.querySelectorAll('.rl-row')].find(r => r.textContent.includes(${JSON.stringify(needle)}))`
const ROWS = `document.querySelectorAll('.rl-row').length`
const ROW_HEIGHTS = `[...document.querySelectorAll('.rl-row')].map(r => Math.round(r.getBoundingClientRect().height))`
const CONN_TAG = `${QUERY('.rl-state')}?.textContent?.trim() || ''`
const MENU_LABELS = `[...document.querySelectorAll('.ant-menu-item')].map(e => e.textContent.trim())`

/** 取某个表达式命中的元素的坐标与尺寸（先滚进视口，坐标与 CDP 的 CSS 像素一致）。 */
const BOX_OF = (expr) => `(() => {
  const el = ${expr}
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
  const r = el.getBoundingClientRect()
  const t = el.querySelector ? el.querySelector('.rl-text') : null
  return { x: Math.round(r.left + Math.min(r.width, 320) / 2), y: Math.round(r.top + r.height / 2),
           h: Math.round(r.height), w: Math.round(r.width),
           sw: t ? t.scrollWidth : 0, cw: t ? t.clientWidth : 0 }
})()`

/** 真鼠标点击：antd 的弹层/下拉都挂在 body 上，按坐标点最稳。 */
async function clickAt(expr, label) {
  const box = await evaluate(BOX_OF(expr))
  if (!box) {
    fail(`${label}：找不到目标元素`)
    return false
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    })
  }
  await sleep(260)
  return true
}

const TYPE = (selector, value) => `(() => {
  const el = ${QUERY(selector)}
  if (!el) return 'not-found'
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
  setter.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`

async function gotoTab(hash) {
  await send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(tk)}#${hash}` })
  await sleep(1200)
}

async function patchTitle(marker) {
  const res = await fetch(`${BASE}/api/requirements/${rid}?token=${encodeURIComponent(tk)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: marker }),
  })
  return res.ok
}

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {
      /* Chrome 还没起来 */
    }
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  // ---------------- 1) 侧栏菜单入口 ----------------
  console.log('1) 侧栏入口')
  // 先把页面导航到目标源再碰 localStorage：Chrome 刚起时当前文档还可能不可写存储
  await send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(tk)}` })
  await sleep(900)
  try {
    await evaluate('localStorage.clear()')
  } catch {
    /* 文档还没就绪：本次用全新 profile，本来也没有凭证需要清 */
  }
  await send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(tk)}` })
  await sleep(600)
  await waitFor(`!!document.querySelector('.hero')`, '令牌登录后进入工作台', 15000)
  const menus = await evaluate(MENU_LABELS)
  expect(menus.some((m) => m.includes('实时日志')), `侧栏有实时日志入口（${JSON.stringify(menus)}）`)
  const clicked = await clickAt(
    `[...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('实时日志'))`,
    '点击实时日志菜单',
  )
  if (clicked) {
    await waitFor(`${QUERY('.rl-console')} !== null`, '进入实时日志页', 10000)
    expect((await evaluate(`location.hash`)) === '#/logs', `路由切到 /logs（${await evaluate('location.hash')}）`)
  }

  // ---------------- 2) 列表渲染 + 单行不变式 ----------------
  console.log('2) 列表渲染')
  await waitFor(`${ROWS} > 0`, '日志行已渲染', 15000)
  await waitFor(`${CONN_TAG}.includes('实时接收中')`, '连接状态为实时接收中', 15000)
  await sleep(600)
  const heights = await evaluate(ROW_HEIGHTS)
  expect(heights.length > 0, `渲染出 ${heights.length} 行`)
  const tallest = Math.max(...heights)
  expect(tallest <= SINGLE_LINE_MAX, `每一行都是单行（最高 ${tallest}px ≤ ${SINGLE_LINE_MAX}px）`)
  await shot('logs-1-list.png')

  // ---------------- 3) 长文本省略 + 点行展开 ----------------
  console.log('3) 长文本省略与展开')
  const row = await evaluate(BOX_OF(ROW_BY_TEXT(`LONG-${STAMP}`)))
  if (!expect(!!row, '找到超长标题那一行')) {
    /* 找不到就没法继续验证展开，直接往后走 */
  } else {
    expect(row.h <= SINGLE_LINE_MAX, `长文本仍是单行（${row.h}px）`)
    expect(row.sw > row.cw, `长文本被省略号收尾（内容 ${row.sw}px > 可视 ${row.cw}px）`)
    await clickAt(ROW_BY_TEXT(`LONG-${STAMP}`), '点击展开该行')
    const open = await evaluate(BOX_OF(ROW_BY_TEXT(`LONG-${STAMP}`)))
    expect(open && open.h > SINGLE_LINE_MAX, `展开后该行变高、全文可见（${open?.h}px）`)
    expect(open && open.sw <= open.cw + 1, '展开后不再横向截断')
    await shot('logs-3-expanded.png')
    await clickAt(ROW_BY_TEXT(`LONG-${STAMP}`), '点击收起该行')
    const back = await evaluate(BOX_OF(ROW_BY_TEXT(`LONG-${STAMP}`)))
    expect(back && back.h <= SINGLE_LINE_MAX, `收起后回到单行（${back?.h}px）`)
  }

  // ---------------- 4) 筛选 ----------------
  console.log('4) 筛选')
  // 级别：全部取消 -> 空态；只留「信息」-> 行回来
  for (const label of ['调试', '信息', '警告', '错误']) {
    await clickAt(
      `[...document.querySelectorAll('.ant-tag-checkable')].find(e => e.textContent.trim() === '${label}')`,
      `取消级别「${label}」`,
    )
  }
  await waitFor(`${ROWS} === 0 && !!document.querySelector('.ant-empty')`, '级别全关后显示空态', 8000)
  await clickAt(
    `[...document.querySelectorAll('.ant-tag-checkable')].find(e => e.textContent.trim() === '信息')`,
    '只勾选「信息」',
  )
  await waitFor(`${ROWS} > 0`, '勾回「信息」后日志回来', 8000)

  // 关键词：搜不到 -> 空态；搜标记 -> 命中
  await evaluate(TYPE('input[placeholder^="搜索日志内容"]', `LONG-${STAMP}`))
  await waitFor(`${ROWS} > 0 && ${ROWS} < 5`, '关键词命中长标题那一行', 8000)
  await evaluate(TYPE('input[placeholder^="搜索日志内容"]', '肯定不存在的关键字zzz'))
  await waitFor(`${ROWS} === 0`, '关键词无命中时给空态', 8000)
  await evaluate(TYPE('input[placeholder^="搜索日志内容"]', ''))

  // 来源：只留「操作留痕」，行仍在（本项目当前只有审计类记录）
  // 注意 antd 6 的 Select 已没有 .ant-select-selector，点击的是搜索输入框本身
  await clickAt(QUERY('.rl-toolbar .ant-select-input'), '打开来源下拉')
  await sleep(500)
  await clickAt(
    `document.querySelector('.ant-select-dropdown .ant-select-item-option[title="操作留痕"]')`,
    '选择来源「操作留痕」',
  )
  await clickAt(QUERY('.rl-title'), '点空白处收起下拉')
  await waitFor(`${ROWS} > 0`, '来源筛选为操作留痕后仍有日志', 8000)
  await shot('logs-2-filter.png')

  // ---------------- 5) 真·实时推送（不刷新页面） ----------------
  console.log('5) 实时推送')
  const live = `LIVE-${STAMP}`
  expect(await patchTitle(live), '外部触发一次需求改名')
  await waitFor(`${ROW_BY_TEXT(live)} !== undefined`, '新日志自动出现在列表里（未刷新页面）', 12000)
  expect((await evaluate(ROW_HEIGHTS)).every((h) => h <= SINGLE_LINE_MAX), '新推送的行同样是单行')
  await shot('logs-4-realtime.png')

  // ---------------- 6) 暂停只冻结屏幕、不丢数据 ----------------
  console.log('6) 暂停与恢复')
  await clickAt(`[...document.querySelectorAll('button')].find(e => e.textContent.includes('暂停'))`, '点击暂停')
  await waitFor(`${QUERY('.rl-paused')} !== null`, '进入暂停态（屏幕已冻结）', 6000)
  const frozen = `FROZEN-${STAMP}`
  expect(await patchTitle(frozen), '暂停期间外部再触发一次改名')
  await sleep(3000)
  expect(
    (await evaluate(`!!${ROW_BY_TEXT(frozen)}`)) === false,
    '暂停期间屏幕不新增（冻结生效）',
  )
  await clickAt(`[...document.querySelectorAll('button')].find(e => e.textContent.includes('继续'))`, '点击继续')
  await waitFor(`!!${ROW_BY_TEXT(frozen)}`, '恢复后暂停期间产生的日志一条不丢地补上', 10000)

  // ---------------- 7) 清屏 ----------------
  console.log('7) 清屏')
  await clickAt(`[...document.querySelectorAll('button')].find(e => e.textContent.includes('清屏'))`, '点击清屏')
  await waitFor(`${ROWS} === 0`, '清屏后列表为空', 6000)
  expect(
    (await evaluate(CONN_TAG)).includes('实时接收中'),
    `清屏不影响实时连接（${await evaluate(CONN_TAG)}）`,
  )

  console.log(`\n实时日志 UI 冒烟${fails.length ? `失败 ${fails.length} 项: ${fails.join('; ')}` : '完成 ✅'}`)
  if (fails.length) process.exitCode = 1
} catch (e) {
  console.error(`实时日志 UI 冒烟失败：${e.message}`)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill()
  await sleep(300)
  try {
    rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  // 清理冒烟项目，不给用户的库里留垃圾
  if (pid) {
    try {
      await adminCall('DELETE', `/api/projects/${pid}`)
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(WS, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
