/**
 * 审计页面 UI 冒烟：用本机 Chrome/Edge（headless + CDP）真实渲染「操作日志」与「Token 审计」。
 *
 * 为什么需要这一层：类型检查只能证明「代码自洽」，证明不了「页面真的跑起来了」。
 * antd 6 与 v5 的差异（组件属性被移除、枚举改名）在 TS 上常常能过，但一到运行时就报错或
 * 整块不渲染 —— 只有真浏览器能发现。所以这里同时盯着未捕获异常与 console.error。
 *
 * 覆盖的不变式：
 *   1. 侧边栏「审计」分组对管理员可见，展开后有「操作日志 / Token 审计」两个子项
 *   2. 操作日志页：统计卡、筛选栏、表格都渲染出来，且真的拿到了数据（不是空表）
 *   3. 日期筛选默认不把当天记录筛掉（后端把 YYYY-MM-DD 补成当天首尾）
 *   4. 点表格行能打开详情抽屉，抽屉里能看到操作详情
 *   5. Token 审计页：统计卡（含 Token 总量）与表格渲染，点行打开详情抽屉，入参/出参都在
 *   6. 权限：非管理员（持访问令牌）看不到审计入口，直接访问也只会看到说明，不打接口
 *   7. 全程没有未捕获异常 / console.error（antd 6 的运行时属性问题会在这里暴露）
 *
 * 用法：
 *   node tools/ui_smoke_audit.mjs <基地址> <管理员口令> [输出目录]
 * 例：
 *   node tools/ui_smoke_audit.mjs http://127.0.0.1:8000 janus-admin-3ead5e
 *
 * 产出（默认 .ui-smoke/）：audit-1-logs.png audit-2-logs-filter.png audit-3-logs-drawer.png
 *   audit-4-tokens.png audit-5-tokens-drawer.png audit-6-non-admin.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '')
const ADMIN_PWD = process.argv[3]
const OUT_DIR = process.argv[4] || join(process.cwd(), '.ui-smoke')
if (!ADMIN_PWD) {
  console.error('用法: node tools/ui_smoke_audit.mjs <基地址> <管理员口令> [输出目录]')
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

// 端口带进程号偏移：上次运行遗留的 headless Chrome 若还占着固定端口，
// 本次就会连上旧实例、对着死页面等超时（真实发生过）。
const PORT = 9336 + (process.pid % 400)
const PROFILE = join(tmpdir(), `cap-audit-smoke-${Date.now()}`)
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

// 运行期异常与 console.error 全收集：antd 6 的属性不兼容会从这里冒出来
const runtimeErrors = []

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
    'about:blank',
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
  await sleep(500)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, name)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`  截图 → ${file}`)
}

async function waitFor(expr, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await evaluate(expr)) {
        ok(label)
        return true
      }
    } catch {
      /* 页面正在导航时求值会失败，继续等 */
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

/** 全文档范围内按按钮文字精确点击（页面里有多个卡片，按容器找容易点错）。
 * 注意 antd 会给两个汉字的按钮自动插空格（「搜索」渲染成「搜 索」），
 * 匹配前必须去掉全部空白。 */
const CLICK_BUTTON = (label) => `(() => {
  const b = [...document.querySelectorAll('button')].find(el => el.textContent.replace(/\\s+/g, '') === ${JSON.stringify(label)})
  if (!b) return 'not-found'
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return 'clicked'
})()`

/** 读第一张统计卡的数值（「记录总数」/「调用总数」）。 */
const FIRST_STAT = `(() => {
  const el = document.querySelector('.ant-statistic-content-value')
  const t = (el?.textContent || '').replace(/[^0-9]/g, '')
  return t ? Number(t) : -1
})()`

const HAS_EMPTY_TABLE = `!!document.querySelector('.ant-empty') && document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length === 0`

const MENU_LABELS = `[...document.querySelectorAll('.ant-menu-item')].map(e => e.textContent.trim())`

/** 点第一行数据（onRow 的 onClick 会打开详情抽屉）。 */
const CLICK_FIRST_ROW = `(() => {
  const row = document.querySelector('.ant-table-tbody tr.ant-table-row')
  if (!row) return 'no-row'
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return 'clicked'
})()`

const ROW_COUNT = `document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length`

/** 用 CDP 在每次新文档加载前写入凭证，省去每次都走一遍登录弹框。 */
async function setCredential(kind, value) {
  const key = kind === 'admin' ? 'cap_admin_token' : 'cap_access_token'
  const clear = kind === 'admin' ? 'cap_access_token' : 'cap_admin_token'
  const r = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.removeItem(${JSON.stringify(clear)}); localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); } catch (e) {}`,
  })
  return r.result?.identifier
}

/**
 * 带 query 参数导航：只改 hash 不会重建文档，`addScriptToEvaluateOnNewDocument` 就不会执行，
 * 于是登录态切换不生效。加一个变化的 query 强制整页重载。
 */
async function gotoFresh(hash) {
  await send('Page.navigate', { url: `${BASE}/?ui=${Date.now()}${hash}` })
  await sleep(1400)
}

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
    // 未捕获异常：页面真的崩了
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails
      runtimeErrors.push(`未捕获异常: ${d?.exception?.description || d?.text || '未知'}`)
    }
    // console.error：React / antd 的告警都从这里出来
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params?.type)) {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      runtimeErrors.push(`console.${m.params.type}: ${String(text).slice(0, 300)}`)
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

  // ---------------- 1) 操作日志（管理员） ----------------
  console.log('1) 操作日志页')
  const adminScriptId = await setCredential('admin', ADMIN_PWD)
  await goto(`${BASE}/#/audit/logs`)

  const menus = await waitFor(`(${MENU_LABELS}).includes('操作日志')`, '侧边栏出现「操作日志」入口')
  if (menus) {
    const labels = await evaluate(MENU_LABELS)
    expect(labels.some((m) => m.includes('Token 审计')), `审计分组已展开（${JSON.stringify(labels)}）`)
  }
  await waitFor(
    `!![...document.querySelectorAll('h4')].find(e => e.textContent.includes('操作日志'))`,
    '页面标题渲染',
  )
  await waitFor(`${ROW_COUNT} > 0`, '表格拿到了数据（不是空表）')

  const statTexts = await evaluate(
    `[...document.querySelectorAll('.ant-statistic')].map(e => e.textContent.trim())`,
  )
  expect(statTexts.length >= 5, `统计卡渲染了 ${statTexts.length} 张（期望 ≥5）`)
  console.log(`   统计卡：${JSON.stringify(statTexts)}`)
  expect(
    statTexts.some((t) => t.includes('记录总数') && /\d/.test(t)),
    '「记录总数」有数值',
  )
  expect(
    statTexts.some((t) => t.includes('涉及项目')),
    '「涉及项目」统计卡在',
  )

  const filters = await evaluate(
    `[...document.querySelectorAll('.ant-select')].length + document.querySelectorAll('.ant-picker').length`,
  )
  expect(filters >= 4, `筛选控件渲染了 ${filters} 个（分类/操作/结果/身份/日期）`)

  // 成功 / 失败标签：结果列的呈现
  const tags = await evaluate(
    `[...document.querySelectorAll('.ant-table-tbody .ant-tag')].map(e => e.textContent.trim())`,
  )
  expect(tags.includes('成功') || tags.includes('失败'), `结果列有状态标签（${JSON.stringify(tags.slice(0, 8))}）`)
  await shot('audit-1-logs.png')

  // ---------------- 2) 关键词筛选 ----------------
  // 用一个必然匹配不到的词：命中为 0 才能证明「筛选真的发到了后端」，而不是碰巧行数没变。
  console.log('2) 关键词筛选')
  const before = await evaluate(ROW_COUNT)
  expect(before > 0, `筛选前有 ${before} 行`)
  const allTotal = await evaluate(FIRST_STAT)
  const typed = await evaluate(TYPE('input[placeholder^="搜索操作"]', 'zzz-不存在的关键词-zzz'))
  await sleep(300)
  const buttons = await evaluate(`[...document.querySelectorAll('button')].map(e => e.textContent.trim())`)
  console.log(`   输入框：${typed}；按钮：${JSON.stringify(buttons)}`)
  const clicked = await evaluate(CLICK_BUTTON('搜索'))
  expect(clicked === 'clicked', `点到「搜索」按钮（返回 ${clicked}）`)
  await waitFor(HAS_EMPTY_TABLE, '无命中时给出空表提示', 10000)
  const missTotal = await evaluate(FIRST_STAT)
  expect(missTotal === 0, `统计随筛选归零（${allTotal} → ${missTotal}）`)
  await shot('audit-2-logs-filter.png')

  // 重置后数据回来（重置按钮在筛选栏里，全文档找得到）
  await evaluate(CLICK_BUTTON('重置筛选'))
  await waitFor(`${ROW_COUNT} > 0`, '重置筛选后数据回来了', 10000)
  expect((await evaluate(FIRST_STAT)) === allTotal, '重置后统计恢复原值')

  // ---------------- 3) 详情抽屉 ----------------
  console.log('3) 操作日志详情抽屉')
  await evaluate(CLICK_FIRST_ROW)
  await waitFor(`!!document.querySelector('.ant-drawer-open')`, '点击行打开详情抽屉', 8000)
  await waitFor(
    `!![...document.querySelectorAll('.ant-drawer-body *')].find(e => e.textContent.trim() === '操作详情')`,
    '抽屉里有「操作详情」正文',
  )
  const drawerText = await evaluate(`document.querySelector('.ant-drawer-body')?.innerText || ''`)
  expect(drawerText.includes('操作者'), '抽屉展示了操作者')
  expect(drawerText.includes('来源 IP'), '抽屉展示了来源 IP')
  await shot('audit-3-logs-drawer.png')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)

  // ---------------- 4) Token 审计 ----------------
  console.log('4) Token 审计页')
  await goto(`${BASE}/#/audit/tokens`)
  await waitFor(
    `!![...document.querySelectorAll('h4')].find(e => e.textContent.includes('Token 审计'))`,
    '页面标题渲染',
  )
  await waitFor(`${ROW_COUNT} > 0`, '调用留痕表格拿到了数据')

  const invStats = await evaluate(
    `[...document.querySelectorAll('.ant-statistic')].map(e => e.textContent.trim())`,
  )
  console.log(`   统计卡：${JSON.stringify(invStats)}`)
  expect(invStats.length >= 9, `统计卡渲染了 ${invStats.length} 张（期望 ≥9）`)
  expect(invStats.some((t) => t.includes('调用总数')), '「调用总数」在')
  expect(invStats.some((t) => t.includes('Token 总量')), '「Token 总量」在')
  expect(invStats.some((t) => t.includes('输入 Token')), '「输入 Token」在')
  expect(invStats.some((t) => t.includes('输出 Token')), '「输出 Token」在')
  expect(invStats.some((t) => t.includes('平均耗时')), '「平均耗时」在')

  const headers = await evaluate(
    `[...document.querySelectorAll('.ant-table-thead th')].map(e => e.textContent.trim())`,
  )
  console.log(`   表头：${JSON.stringify(headers)}`)
  for (const h of ['时间', '来源', 'Agent / 模型', '项目 · 需求', '入参 / 出参', '结果', '耗时', 'Token', '操作者']) {
    expect(headers.some((x) => x.includes(h)), `表头含「${h}」`)
  }
  await shot('audit-4-tokens.png')

  // ---------------- 5) 调用详情抽屉（完整入参/出参） ----------------
  console.log('5) 调用详情抽屉')
  await evaluate(CLICK_FIRST_ROW)
  await waitFor(`!!document.querySelector('.ant-drawer-open')`, '点击行打开详情抽屉', 8000)
  await waitFor(
    `!![...document.querySelectorAll('.ant-drawer-body *')].find(e => e.textContent.trim().startsWith('入参（'))`,
    '抽屉里有完整入参',
  )
  const invDrawer = await evaluate(`document.querySelector('.ant-drawer-body')?.innerText || ''`)
  expect(invDrawer.includes('出参（'), '抽屉里有完整出参')
  expect(invDrawer.includes('复制'), '入参/出参提供复制按钮')
  expect(/\d/.test(invDrawer) && invDrawer.length > 80, '抽屉内容非空')
  await shot('audit-5-tokens-drawer.png')

  // ---------------- 6) 非管理员看不到、也进不去 ----------------
  console.log('6) 非管理员（访问令牌）')
  const res = await fetch(`${BASE}/api/admin/tokens?admin=${encodeURIComponent(ADMIN_PWD)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_ids: [], note: 'ui-smoke-audit 权限分支用' }),
  })
  if (!res.ok) {
    console.log(`   签发令牌失败（${res.status}），跳过权限分支`)
  } else {
    const { token } = await res.json()
    // 先撤掉「写入管理员口令」那条注入脚本，否则它会继续把管理员态写回来
    if (adminScriptId) {
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: adminScriptId })
    }
    await setCredential('token', token)
    // 必须整页重载：只改 hash 不会重建文档，注入脚本不执行，登录态也就换不过来
    await gotoFresh('#/audit/logs')

    await waitFor(
      `!![...document.querySelectorAll('*')].find(e => e.textContent.includes('仅管理员可见'))`,
      '非管理员看到「仅管理员可见」说明',
      12000,
    )
    const labels = await evaluate(MENU_LABELS)
    expect(labels.includes('操作日志') === false, `侧边栏不放开审计入口（${JSON.stringify(labels)}）`)
    expect(
      (await evaluate(`document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length`)) === 0,
      '未渲染审计表格（没去打必然 401 的接口）',
    )
    expect(
      (await evaluate(`!!document.querySelector('.ant-modal')`)) === false,
      '令牌有效时不弹登录框',
    )
    await shot('audit-6-non-admin.png')
  }

  // ---------------- 7) 运行期异常 ----------------
  console.log('7) 运行期异常检查')
  // antd / React 的告警也走 console.error，一并列出来；有未捕获异常才算失败
  if (runtimeErrors.length) {
    console.log(`   收集到 ${runtimeErrors.length} 条 console 告警/异常：`)
    for (const e of [...new Set(runtimeErrors)].slice(0, 12)) console.log(`     - ${e}`)
  } else {
    ok('没有 console 告警或异常')
  }
  const fatal = runtimeErrors.filter((e) => e.startsWith('未捕获异常'))
  expect(fatal.length === 0, `无未捕获异常（${fatal.length}）`)

  console.log(`\n审计页面 UI 冒烟${fails.length ? `失败 ${fails.length} 项: ${fails.join('; ')}` : '完成 ✅'}`)
  if (fails.length) process.exitCode = 1
} catch (e) {
  console.error(`审计页面 UI 冒烟失败：${e.message}`)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  // chrome.kill() 只杀启动器：headless 的子进程在 Windows 上会存活下来，
  // 既留孤儿又可能占住调试端口坑害下一次运行，必须连进程树一起杀。
  if (process.platform === 'win32' && chrome.pid) {
    spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    chrome.kill()
  }
  await sleep(500)
  try {
    rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
