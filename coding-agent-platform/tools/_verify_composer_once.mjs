/**
 * 一次性验证（工作台对话输入框改版）：Agent 选择是否收进输入框、`+` 入口是否可用。
 *
 * 对应改动：ChatPanel 由「textarea + 下方外置工具条」改为「圆角输入框 = 正文 + 内嵌工具条」，
 * 左下角 `+`（上传文件 / 上传图片 / 常用指令），右下角 Agent 选择 + 停止 + 圆形发送。
 *
 * 用法: node tools/_verify_composer_once.mjs "<带 token 的工作台 URL>" [输出目录]
 *
 * 验证完即可删除；长期回归请把断言并入 tools/ui_smoke_workbench.mjs。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ARG = process.argv[2]
const OUT_DIR = process.argv[3] || join(process.cwd(), '.ui-smoke')
if (!URL_ARG) {
  console.error('用法: node tools/_verify_composer_once.mjs "<工作台 URL>" [输出目录]')
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
  console.error('未找到 Chrome / Edge，跳过验证')
  process.exit(3)
}

const PORT = 9339
const PROFILE = join(tmpdir(), `cap-composer-${Date.now()}`)
mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = []
const ok = (m) => console.log(`  ✓ ${m}`)
const fail = (m) => {
  fails.push(m)
  console.log(`  ✗ ${m}`)
}
const check = (cond, label, extra = '') => (cond ? ok(label) : fail(`${label}${extra ? ' — ' + extra : ''}`))

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
    URL_ARG,
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}

async function shot(name) {
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
    await sleep(250)
  }
}

/** 给受控 textarea 写值（绕过 React 的 value setter）。 */
async function setTextarea(sel, value) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return 'not-found'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value.length
  })()`)
}

/** 点击某选择器命中的元素（合成事件需要 bubbles 才能到 React 根）。 */
async function clickSel(sel) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return 'not-found'
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
}

/** 按可见文本点击 Dropdown 菜单项。 */
async function clickMenuItem(label) {
  const r = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find(e => (e.textContent || '').includes(${JSON.stringify(label)}))
    if (!el) return 'not-found'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  if (r !== 'clicked') fail(`点击菜单项「${label}」失败：${r}`)
  return r
}

/** 点空白处收起 Dropdown（antd 监听 document 上的 outside click）。 */
async function closeDropdown() {
  await evaluate(`(() => {
    const el = document.querySelector('.chat-scroll') || document.body
    for (const t of ['mousedown', 'mouseup', 'click'])
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
    return true
  })()`)
  await sleep(400)
}

const menuTexts = () =>
  evaluate(`[...document.querySelectorAll('.ant-dropdown-menu-item')].map(e => e.textContent.trim())`)

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

  console.log('1) 输入框结构')
  await waitFor(`!!document.querySelector('.wb-right .chat-pane')`, '对话面板出现')
  await waitFor(`!!document.querySelector('.composer-box')`, '圆角输入框（.composer-box）出现')
  check(await evaluate(`!!document.querySelector('.composer-box textarea')`), '输入框内有 textarea')

  const box = await evaluate(`(() => {
    const b = document.querySelector('.composer-box'); const t = b?.querySelector('textarea')
    if (!b || !t) return null
    const bs = getComputedStyle(b), ts = getComputedStyle(t)
    return { boxBorder: bs.borderTopWidth, boxRadius: bs.borderTopLeftRadius, taBorder: ts.borderTopWidth, taBg: ts.backgroundColor }
  })()`)
  check(!!box && box.boxBorder !== '0px', '外层盒自带边框（取代原 textarea 边框）', JSON.stringify(box))
  check(!!box && box.taBorder === '0px', 'textarea 自身无边框（borderless 变体生效）')

  console.log('2) 工具条：`+` 添加入口')
  const plus = await evaluate(`(() => {
    const b = document.querySelector('.composer-box [aria-label="添加内容"]')
    if (!b) return null
    const r = b.getBoundingClientRect(), boxR = document.querySelector('.composer-box').getBoundingClientRect()
    return { text: (b.textContent || '').trim(), leftOffset: Math.round(r.left - boxR.left), inBox: r.top >= boxR.top && r.bottom <= boxR.bottom }
  })()`)
  check(!!plus, '`+` 按钮存在（aria-label=添加内容）')
  check(!!plus && plus.inBox, '`+` 位于输入框内部')
  check(!!plus && plus.leftOffset < 40, '`+` 贴左侧', JSON.stringify(plus))

  await clickSel('.composer-box [aria-label="添加内容"]')
  await sleep(600)
  const plusItems = (await menuTexts()) || []
  console.log(`   + 菜单：${JSON.stringify(plusItems)}`)
  check(plusItems.some((t) => t.includes('上传文件')), '+ 菜单含「上传文件」')
  check(plusItems.some((t) => t.includes('上传图片')), '+ 菜单含「上传图片」')
  check(plusItems.some((t) => t.includes('常用指令')), '+ 菜单含「常用指令」')

  await clickMenuItem('常用指令')
  await sleep(600)
  const afterSlash = await evaluate(`document.querySelector('.composer-box textarea')?.value || ''`)
  check(afterSlash === '/', '+ 菜单跳转后输入框被填入 /', JSON.stringify(afterSlash))
  const slashOpen = await waitFor(`document.querySelectorAll('.slash-menu .slash-item').length >= 4`, '斜杠指令菜单被唤起')
  const slashCount = await evaluate(`document.querySelectorAll('.slash-menu .slash-item').length`)
  console.log(`   指令条数：${slashCount}`)
  await shot('composer-plus-menu.png')

  // 收尾：Esc 关菜单 + 清空输入框
  await evaluate(`(() => {
    const ta = document.querySelector('.composer-box textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await setTextarea('.composer-box textarea', '')
  await closeDropdown()

  console.log('3) Agent 选择收进输入框')
  check(
    (await evaluate(`!!document.querySelector('.chat-agent-bar')`)) === false,
    '旧的外置 Agent 条（.chat-agent-bar）已移除',
  )
  const chip = await evaluate(`(() => {
    const c = document.querySelector('.composer-box .composer-agent')
    if (!c) return null
    const r = c.getBoundingClientRect(), boxR = document.querySelector('.composer-box').getBoundingClientRect()
    return {
      text: (c.textContent || '').trim(),
      inBox: r.top >= boxR.top && r.bottom <= boxR.bottom,
      // 右侧还有发送按钮，所以「靠右下」用「中心在右半 + 底部贴合」判定
      inRightHalf: r.left + r.width / 2 > boxR.left + boxR.width / 2,
      bottomGap: Math.round(boxR.bottom - r.bottom),
      boxWidth: Math.round(boxR.width),
    }
  })()`)
  check(!!chip, 'Agent 选择器存在于输入框内（.composer-box .composer-agent）')
  check(!!chip && chip.inBox, 'Agent 选择器位于输入框内部')
  check(!!chip && chip.inRightHalf && chip.bottomGap <= 24, 'Agent 选择器位于输入框右下角', JSON.stringify(chip))
  console.log(`   当前 Agent：${chip?.text}`)

  await clickSel('.composer-box .composer-agent')
  await sleep(700)
  const agentItems = (await menuTexts()) || []
  console.log(`   Agent 菜单：${JSON.stringify(agentItems)}`)
  check(agentItems.length >= 2, '下拉列出了多个 Agent（本机有 codebuddy / cursor）')
  check(agentItems.some((t) => t.includes('codebuddy')), 'Agent 菜单含当前 Agent codebuddy')
  check(agentItems.some((t) => t.includes('cursor')), 'Agent 菜单含 cursor')
  await shot('composer-agent-menu.png')
  await closeDropdown()

  console.log('4) 发送 / 停止按钮')
  const sendBtn = await evaluate(`(() => {
    const b = document.querySelector('.composer-send')
    if (!b) return null
    const r = b.getBoundingClientRect(), s = getComputedStyle(b)
    return {
      w: Math.round(r.width), h: Math.round(r.height), disabled: b.disabled,
      minW: s.minWidth, padding: s.padding, box: s.boxSizing, radius: s.borderRadius,
    }
  })()`)
  console.log(`   发送按钮：[${JSON.stringify(sendBtn)}]`)
  check(!!sendBtn && Math.abs(sendBtn.w - sendBtn.h) <= 1, '发送按钮为圆形（宽高一致）', JSON.stringify(sendBtn))

  console.log('5) 交互回归：Enter 发送仍可用（只校验按钮禁用态随文本变化，不真发消息）')
  await setTextarea('.composer-box textarea', '冒烟占位文本')
  await sleep(300)
  check(
    (await evaluate(`document.querySelector('.composer-send')?.disabled`)) === false,
    '有文本时发送按钮可用',
  )
  await setTextarea('.composer-box textarea', '')
  await sleep(300)
  check(
    (await evaluate(`document.querySelector('.composer-send')?.disabled`)) === true,
    '清空后发送按钮禁用',
  )

  await shot('composer-final.png')
  console.log(`\n输入框验证${fails.length ? `失败 ${fails.length} 项: ${fails.join('; ')}` : '全部通过 ✅'}`)
  if (fails.length) process.exitCode = 1
} catch (e) {
  console.error(`输入框验证失败：${e.message}`)
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
