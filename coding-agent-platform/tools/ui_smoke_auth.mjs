/**
 * 统一认证 UI 冒烟：用本机 Chrome/Edge（headless + CDP）真实走一遍登录门禁。
 *
 * 覆盖的不变式（都是本次「认证体系统一」的核心承诺）：
 *   1. 未登录打开页面 → 登录弹框强制弹出，且不可关闭；路由不挂载（不会先刷一片 401 报错）
 *   2. 弹框内可切换「令牌登录 / 管理员登录」两种模式
 *   3. 管理员口令错误 → 明确报错；口令正确 → 弹框关闭、进入工作台、侧边栏放开后台入口
 *   4. 刷新页面仍是登录态（凭证已落盘，不再依赖地址栏 ?token=）
 *   5. 退出登录 → 立即回到强制登录弹框
 *   6. 令牌登录 → 进入工作台但不放开管理员入口（权限确实按登录方式区分）
 *
 * 用法：
 *   node tools/ui_smoke_auth.mjs <基地址> <管理员口令> [输出目录]
 * 例：
 *   node tools/ui_smoke_auth.mjs http://127.0.0.1:8000 janus-admin-3ead5e
 *
 * 产出（默认 .ui-smoke/）：auth-1-forced-modal.png auth-2-admin-error.png
 *   auth-3-admin-ok.png auth-4-reloaded.png auth-5-account-modal.png
 *   auth-6-token-login.png auth-7-share-link.png auth-8-bad-share-link.png
 *   auth-9-deeplink.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '')
const ADMIN_PWD = process.argv[3]
const OUT_DIR = process.argv[4] || join(process.cwd(), '.ui-smoke')
if (!ADMIN_PWD) {
  console.error('用法: node tools/ui_smoke_auth.mjs <基地址> <管理员口令> [输出目录]')
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

const PORT = 9334
const PROFILE = join(tmpdir(), `cap-auth-smoke-${Date.now()}`)
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

// 先用管理接口签一枚令牌，供「令牌登录」分支使用
let shareToken = null
try {
  const res = await fetch(`${BASE}/api/admin/tokens?admin=${encodeURIComponent(ADMIN_PWD)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_ids: [], note: 'ui-smoke 令牌登录用' }),
  })
  if (res.ok) {
    shareToken = (await res.json()).token
    console.log(`已签发冒烟令牌：${shareToken ? shareToken.slice(0, 8) + '…' : '(空)'}`)
  } else {
    console.log(`签发冒烟令牌失败（${res.status}），将跳过令牌登录分支`)
  }
} catch (e) {
  console.log(`签发冒烟令牌异常：${e.message}，将跳过令牌登录分支`)
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
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}

async function shot(name) {
  await sleep(500) // 等弹框淡入 / 列表重排落定，否则截图可能拍到动画中间态
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, name)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`  截图 → ${file}`)
}

async function waitFor(expr, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await evaluate(expr)) {
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

/** React 受控输入必须走原生 setter + input 事件，直接改 .value 不会触发 onChange。 */
const TYPE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'not-found'
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
  setter.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`

const CLICK_TEXT = (scope, label) => `(() => {
  const root = document.querySelector(${JSON.stringify(scope)})
  if (!root) return 'no-scope'
  const b = [...root.querySelectorAll('button')].find(el => el.textContent.includes(${JSON.stringify(label)}))
  if (!b) return 'not-found'
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return 'clicked'
})()`

/** antd Segmented 的选项：点到内部 label 才会命中。 */
const CLICK_SEGMENT = (label) => `(() => {
  const it = [...document.querySelectorAll('.ant-segmented-item')]
    .find(el => el.textContent.includes(${JSON.stringify(label)}))
  if (!it) return 'not-found'
  const target = it.querySelector('.ant-segmented-item-label') || it
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return 'clicked'
})()`

const MENU_LABELS = `[...document.querySelectorAll('.ant-menu-item')].map(e => e.textContent.trim())`

async function goto(url) {
  await send('Page.navigate', { url })
  await sleep(1200)
}

try {
  // 1) 连上 CDP
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

  // ---------------- 1) 未登录：强制弹框 ----------------
  console.log('1) 未登录打开页面')
  await waitFor(`!!document.querySelector('.ant-modal')`, '登录弹框自动弹出')
  expect(
    (await evaluate(`document.querySelector('.ant-modal-title')?.textContent || ''`)).includes('登录'),
    '弹框标题是登录',
  )
  expect(
    (await evaluate(`!!document.querySelector('.ant-modal-close')`)) === false,
    '未登录时弹框没有关闭按钮（强制登录）',
  )
  const segs = await evaluate(
    `[...document.querySelectorAll('.ant-segmented-item')].map(e => e.textContent.trim())`,
  )
  expect(segs.some((s) => s.includes('令牌登录')), `弹框提供令牌登录（${JSON.stringify(segs)}）`)
  expect(segs.some((s) => s.includes('管理员登录')), '弹框提供管理员登录')
  expect(
    (await evaluate(`!!document.querySelector('.hero')`)) === false,
    '未登录时不挂载路由（工作台内容未渲染）',
  )
  await sleep(700) // 等 antd 弹框的淡入动画走完，否则截图里看不到弹框
  await shot('auth-1-forced-modal.png')

  // ---------------- 2) 管理员登录：错误口令要有明确报错 ----------------
  console.log('2) 管理员登录（错误口令）')
  await evaluate(CLICK_SEGMENT('管理员登录'))
  await sleep(400)
  await waitFor(`!!document.querySelector('.ant-modal input[type=password]')`, '切到管理员登录表单', 6000)
  await evaluate(TYPE('.ant-modal input[type=password]', 'definitely-wrong'))
  await sleep(200)
  await evaluate(CLICK_TEXT('.ant-modal', '登录'))
  await waitFor(
    `!!document.querySelector('.ant-modal .ant-alert-error')`,
    '错误口令给出错误提示',
    8000,
  )
  console.log(
    `   提示文案：${await evaluate(`document.querySelector('.ant-modal .ant-alert-error')?.textContent || ''`)}`,
  )
  await shot('auth-2-admin-error.png')

  // ---------------- 3) 管理员登录：正确口令进入工作台 ----------------
  console.log('3) 管理员登录（正确口令）')
  await evaluate(TYPE('.ant-modal input[type=password]', ADMIN_PWD))
  await sleep(200)
  await evaluate(CLICK_TEXT('.ant-modal', '登录'))
  const closed = await waitFor(
    `!document.querySelector('.ant-modal') || document.querySelector('.ant-modal-wrap')?.style.display === 'none'`,
    '登录成功后弹框关闭',
    10000,
  )
  if (closed) {
    await waitFor(`!!document.querySelector('.hero')`, '工作台内容渲染')
    const menus = await evaluate(MENU_LABELS)
    expect(menus.some((m) => m.includes('管理台')), `管理员可见管理台入口（${JSON.stringify(menus)}）`)
    expect(menus.some((m) => m.includes('Agent 管理')), '管理员可见 Agent 管理入口')
    await shot('auth-3-admin-ok.png')
  }

  // ---------------- 4) 刷新仍是登录态 ----------------
  console.log('4) 刷新页面')
  await send('Page.reload', { ignoreCache: false })
  await sleep(1500)
  await waitFor(`!!document.querySelector('.hero')`, '刷新后仍是登录态（凭证已落盘）')
  expect(
    (await evaluate(`!!document.querySelector('.ant-modal-title')`)) === false,
    '刷新后不再弹登录框',
  )
  await shot('auth-4-reloaded.png')

  // ---------------- 5) 退出登录（头像下拉 → 切换身份 → 弹框内退出） ----------------
  console.log('5) 退出登录')
  await evaluate(`(() => {
    const av = document.querySelector('.ant-avatar')
    if (!av) return 'no-avatar'
    av.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  await waitFor(`!!document.querySelector('.ant-dropdown-menu-item')`, '头像下拉打开', 8000)
  await evaluate(`(() => {
    const it = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(e => e.textContent.includes('切换登录身份'))
    if (!it) return 'not-found'
    it.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  await waitFor(`!!document.querySelector('.ant-modal')`, '账号弹框打开', 8000)
  await waitFor(`!!document.querySelector('.ant-modal-close')`, '已登录时弹框可关闭（退化为账号弹框）', 6000)
  await shot('auth-5-account-modal.png')
  await evaluate(CLICK_TEXT('.ant-modal', '退出登录'))
  await waitFor(
    `!!document.querySelector('.ant-modal input[type=password]') || !!document.querySelector('.ant-modal textarea')`,
    '退出后回到登录表单',
    8000,
  )
  expect(
    (await evaluate(`!!document.querySelector('.ant-modal-close')`)) === false,
    '退出后弹框重新变为强制且不可关闭',
  )
  expect(
    (await evaluate(`!!document.querySelector('.hero')`)) === false,
    '退出后路由不再挂载',
  )

  // ---------------- 6) 令牌登录 ----------------
  if (shareToken) {
    console.log('6) 令牌登录')
    await evaluate(CLICK_SEGMENT('令牌登录'))
    await sleep(400)
    await waitFor(`!!document.querySelector('.ant-modal textarea')`, '切到令牌登录表单', 6000)
    await evaluate(TYPE('.ant-modal textarea', shareToken))
    await sleep(200)
    await evaluate(CLICK_TEXT('.ant-modal', '登录'))
    await waitFor(`!!document.querySelector('.hero')`, '令牌登录后进入工作台', 10000)
    const menus = await evaluate(MENU_LABELS)
    expect(
      menus.some((m) => m.includes('管理台')) === false,
      `令牌登录不放开管理台入口（${JSON.stringify(menus)}）`,
    )
    await shot('auth-6-token-login.png')
  } else {
    console.log('6) 跳过令牌登录分支（没有拿到冒烟令牌）')
  }

  // ---------------- 7) 分享链接 ?token= 直达 ----------------
  // 这是平台的核心入口（把链接发给业务人员），改动令牌存储后必须回归。
  if (shareToken) {
    console.log('7) 分享链接直达')
    await evaluate(`localStorage.clear()`)
    await goto(`${BASE}/?token=${shareToken}`)
    await waitFor(`!!document.querySelector('.hero')`, '分享链接直接进入工作台', 12000)
    expect(
      (await evaluate(`!!document.querySelector('.ant-modal-title')`)) === false,
      '分享链接不弹登录框',
    )
    // 令牌应已被搬到 localStorage 并从地址栏抹掉，避免长期外泄在 URL / 浏览器历史里
    expect(
      (await evaluate(`!!localStorage.getItem('cap_access_token')`)) === true,
      '分享令牌已落盘到 localStorage',
    )
    console.log(`   地址栏 search：${(await evaluate(`location.search`)) || '(已清空)'}`)
    await shot('auth-7-share-link.png')
  }

  // ---------------- 8) 无效分享链接：给出提示并回到强制登录 ----------------
  console.log('8) 无效分享链接')
  await evaluate(`localStorage.clear()`)
  await goto(`${BASE}/?token=this-token-does-not-exist`)
  await waitFor(`!!document.querySelector('.ant-modal')`, '无效分享链接回到登录弹框', 12000)
  const noticeText = await evaluate(
    `document.querySelector('.ant-modal .ant-alert-warning')?.textContent || ''`,
  )
  expect(
    noticeText.includes('分享链接') && noticeText.includes('令牌'),
    `给出失效原因（${noticeText || '无提示'}）`,
  )
  expect(
    (await evaluate(`location.search.includes('this-token-does-not-exist')`)) === false,
    '无效令牌已从地址栏清除',
  )
  await shot('auth-8-bad-share-link.png')

  // ---------------- 9) 分享链接 + hash 深链 ----------------
  // 抹地址栏那一步用的是 replaceState，必须确认它没有把 HashRouter 的路由位置一起弄丢。
  if (shareToken) {
    console.log('9) 分享链接 + 深链')
    await evaluate(`localStorage.clear()`)
    await goto(`${BASE}/?token=${shareToken}#/projects`)
    await waitFor(`!!document.querySelector('.ant-card')`, '深链直达项目空间', 12000)
    expect(
      (await evaluate(`location.hash`)) === '#/projects',
      `hash 路由位置保留（${await evaluate(`location.hash`)}）`,
    )
    expect(
      (await evaluate(`location.search`)) === '',
      '令牌已抹出地址栏',
    )
    await shot('auth-9-deeplink.png')
  }

  console.log(`\n认证 UI 冒烟${fails.length ? `失败 ${fails.length} 项: ${fails.join('; ')}` : '完成 ✅'}`)
  if (fails.length) process.exitCode = 1
} catch (e) {
  console.error(`认证 UI 冒烟失败：${e.message}`)
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
}
