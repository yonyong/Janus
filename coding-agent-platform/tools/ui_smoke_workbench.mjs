/**
 * 工作台 UI 冒烟：用本机 Chrome/Edge（headless + CDP）真实渲染页面并逐阶段截图。
 *
 * 用途：没有 agent-browser 时也能核对前端布局与交互是否真的生效 ——
 * 工作流四个阶段是否可点切换、各阶段左栏是否渲染出对应面板、文件树能否懒加载、
 * 悬停操作按钮是否显形。截图落盘后可人工复核，stdout 里的断言可被 grep 消费。
 *
 * 阶段无关：页面按数据库里存的阶段渲染，本脚本会先读出进入时的阶段，
 * 依次切到四个阶段截图与断言，跑完再还原回进入时的阶段（不擅自改演示数据）。
 *
 * 除了「看得见」，也走一遍「改得动」：需求澄清阶段会真的改一行文档 → 保存 →
 * 在历史版本里回退回去，以此验证版本链路在真实 UI 上是通的。
 *
 * 用法：
 *   node tools/ui_smoke_workbench.mjs "<带 token 的工作台 URL>" [输出目录]
 *
 * 产出（默认 .ui-smoke/）：
 *   ui-1-clarify.png  ui-1b-versions.png  ui-2-build.png  ui-2b-changes.png
 *   ui-3-verify.png   ui-4-archive.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ARG = process.argv[2]
const OUT_DIR = process.argv[3] || join(process.cwd(), '.ui-smoke')
if (!URL_ARG) {
  console.error('用法: node tools/ui_smoke_workbench.mjs "<工作台 URL>" [输出目录]')
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

const PORT = 9333
const PROFILE = join(tmpdir(), `cap-ui-smoke-${Date.now()}`)
mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = []
const fail = (msg) => {
  fails.push(msg)
  console.log(`  ✗ ${msg}`)
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

/** 轮询直到表达式返回真值；超时记失败但不抛（后续步骤仍会尝试）。 */
async function waitFor(expr, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await evaluate(expr)) {
      console.log(`  ✓ ${label}`)
      return true
    }
    if (Date.now() > deadline) {
      fail(`等待超时：${label}`)
      return false
    }
    await sleep(250)
  }
}

/** 点击左栏竖向分类页签：按文本定位（新 UI 无顶部步骤条）。 */
async function clickRail(label) {
  const r = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.wfa-rail-item')]
    const hit = items.find(el => el.querySelector('.wfa-rail-label')?.textContent?.trim() === ${JSON.stringify(label)})
    if (!hit) return 'not-found'
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  if (r !== 'clicked') fail(`点击左栏分类「${label}」失败：${r}`)
  return r
}

async function clickNode(name) {
  const r = await evaluate(`(() => {
    const n = [...document.querySelectorAll('.fp-node')]
      .find(e => e.querySelector('.fp-name')?.textContent === ${JSON.stringify(name)})
    if (!n) return 'not-found'
    n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  if (r !== 'clicked') fail(`点击文件树节点「${name}」失败：${r}`)
  return r
}

const text = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`)
const count = (sel) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`)
const nodeNames = () => evaluate(`[...document.querySelectorAll('.fp-node .fp-name')].map(e => e.textContent)`)

/** 抽屉关没关：antd 关闭后默认保留 DOM（只是移出视口），所以不能断言元素消失。 */
const DRAWER_CLOSED = `(() => {
  const d = document.querySelector('.ant-drawer')
  return !d || !String(d.className).includes('open')
})()`

/** 按可见文本点击容器内的第一个按钮/项（比拿 class 硬编码稳）。 */
async function clickByText(sel, label) {
  const r = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find(e => (e.textContent || '').includes(${JSON.stringify(label)}))
    if (!el) return 'not-found'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  if (r !== 'clicked') fail(`点击「${label}」失败：${r}`)
  return r
}

/**
 * 往受控 textarea 里写值。
 * React 接管了 value setter，直接 el.value = x 不会触发 onChange，
 * 必须走原型上的原生 setter 再派发 input 事件。
 */
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

/**
 * 展开文件树里的某个目录，直到可见节点变多为止。
 *
 * 目录行本身就是展开入口（单击展开 / 再单击收起），所以只在「节点数没变」时才点，
 * 一旦变多立刻收手，避免把刚展开的目录又点回去。允许多次重试是因为进入阶段后
 * 紧接着点击时，React 可能正在重挂载节点 —— 那一击会落在已脱离文档的元素上，
 * 事件不会冒泡到 React 根节点，表现为「点了没反应」。
 */
async function expandDir(name, tries = 8, settleMs = 400) {
  const before = await count('.fp-node')
  for (let i = 0; i < tries; i++) {
    if ((await count('.fp-node')) > before) return true
    if ((await clickNode(name)) !== 'clicked') return false
    await sleep(settleMs)
  }
  return (await count('.fp-node')) > before
}

/** 当前阶段 chip 文本。 */
const activeStage = () =>
  evaluate(
    `document.querySelector('.wb-stage-chip')?.textContent?.trim() || ''`,
  )

/** 左栏分类就绪的判定选择器：切换后用它确认面板真的渲染出来了。 */
const CAT_READY = {
  需求文档: ['.doc-editor', '需求文档编辑器'],
  用例: ['.case-pane', '用例面板'],
  项目文件: ['.wb-tabs', '文件树面板'],
  归档: ['.arc-card', '归档汇总卡片'],
}

/** 流程指令清单数据是否已到位（requirementWorkflow 已返回，6 条指令都渲染出来）。 */
const flowLoadedExpr = `document.querySelectorAll('.fc-row').length >= 6`

/** 切到指定分类并等待其面板就绪。 */
async function gotoCat(label) {
  const [sel, name] = CAT_READY[label] || [null, label]
  await clickRail(label)
  if (!sel) return false
  return waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, `${name}出现`)
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

  // ---------------- 阶段一：需求澄清 ----------------
  // 页面按数据库里存的阶段渲染，进来不一定是「需求澄清」（上一次冒烟或人工操作
  // 可能把它留在后面某个阶段），所以先读出初始阶段用于收尾还原，再显式切过去。
  console.log('1) 需求澄清')
  if (!(await waitFor(`!!document.querySelector('.flow-cmds')`, '流程指令清单出现'))) {
    throw new Error('流程指令清单未渲染，后续无法继续')
  }
  // 默认收起：验证初始态，再点头部展开做后续断言
  if (!(await evaluate(`!!document.querySelector('.flow-cmds.closed')`))) {
    fail('流程指令清单应默认收起')
  }
  await evaluate(`document.querySelector('.fc-head')?.click()`)
  // 等看板数据到位：6 条流程指令都渲染出来即 requirementWorkflow 已返回
  await waitFor(flowLoadedExpr, '工作流看板数据加载完成')
  const fcCount = await count('.fc-row')
  console.log(`   流程指令条数：${fcCount}`)
  if (fcCount !== 6) fail(`流程指令应有 6 条，实际 ${fcCount}`)
  await sleep(400)
  const initialStage = await activeStage()
  console.log(`   进入时阶段：${initialStage || '(未识别)'}`)

  if (await gotoCat('需求文档')) {
    const docLen = await evaluate(`document.querySelector('.doc-editor')?.value?.length || 0`)
    console.log(`   需求文档字数：${docLen}`)
    console.log(`   右栏对话输入框：${(await count('.chat-input, textarea')) > 0}`)
    console.log('   润色工具栏存在：', await evaluate(`!!document.querySelector('.doc-toolbar')`))
    await shot('ui-1-clarify.png')

    // ---- 历史版本：查看 → 改一行保存 → 回退 ----
    if ((await clickByText('.doc-toolbar button', '历史版本')) === 'clicked') {
      await waitFor(`document.querySelectorAll('.vh-item').length > 0`, '历史版本列表', 10000)
      const baseCount = await count('.vh-item')
      console.log(`   历史版本数：${baseCount}`)
      console.log(
        `   版本来源：${JSON.stringify(
          await evaluate(
            `[...document.querySelectorAll('.vh-item .ant-tag')].map(e => e.textContent.trim())`,
          ),
        )}`,
      )
      // 选中最早那一版，切到「与当前对比」；顺便记下「当前」标记所在版本的 id，
      // 后面回退要精确还原到改动前的这一版（列表是新→旧排序，按序号猜会踩空）
      const curVid = await evaluate(`(() => {
        const cur = [...document.querySelectorAll('.vh-item')].find((e) => e.classList.contains('is-current'))
        const m = (cur?.textContent || '').match(/#(\\d+)/)
        return m ? m[1] : ''
      })()`)
      await evaluate(`(() => {
        const it = [...document.querySelectorAll('.vh-item')]
        it[it.length - 1]?.click()
        return true
      })()`)
      await waitFor(`!!document.querySelector('.vh-doc')`, '版本正文预览', 8000)
      await clickByText('.vh-detail-head .ant-segmented-item', '与当前对比')
      await sleep(500)
      console.log(
        `   对比视图渲染：${await evaluate(
          `!!document.querySelector('.vh-diff-body') || !!document.querySelector('.vh-detail .ant-alert')`,
        )}`,
      )
      await shot('ui-1b-versions.png')

      // 关抽屉，改一行再保存 —— 这是在真实 UI 上产生新版本
      await evaluate(`document.querySelector('.ant-drawer-close')?.click(); true`)
      await waitFor(DRAWER_CLOSED, '抽屉关闭', 8000)
      const original = await evaluate(`document.querySelector('.doc-editor')?.value || ''`)
      await setTextarea('.doc-editor', original + '\n\n（UI 冒烟临时改动）')
      await sleep(250)
      await clickByText('.doc-toolbar button', '保存')
      if (
        await waitFor(
          `!document.querySelector('.doc-head .ant-tag.ant-tag-orange')`,
          '保存完成（未保存标记消失）',
          15000,
        )
      ) {
        console.log('  ✓ 文档已保存')
      }

      // 再开抽屉：版本应变多，并把文档回退回最初内容
      await clickByText('.doc-toolbar button', '历史版本')
      if (await waitFor(`document.querySelectorAll('.vh-item').length > ${baseCount}`, '保存后新增版本', 10000)) {
        console.log(`   保存后版本数：${await count('.vh-item')}`)
        // 精确点回「改动前的那一版」（按版本 id 找，不依赖列表顺序）：
        // 最新版本是刚保存的临时改动，直接点最后一项会回退到最早的创建版
        await evaluate(`(() => {
          const it = [...document.querySelectorAll('.vh-item')]
          const re = new RegExp('#' + ${JSON.stringify(curVid)} + '(?![0-9])')
          ;(it.find((e) => re.test(e.textContent)) || it[it.length - 1])?.click()
          return true
        })()`)
        await sleep(400)
        await clickByText('.vh-detail-head button', '回退到此版本')
        if (await waitFor(`!!document.querySelector('.ant-popover .ant-btn-primary')`, '回退确认框', 6000)) {
          await evaluate(`document.querySelector('.ant-popover .ant-btn-primary')?.click(); true`)
          await waitFor(`document.querySelectorAll('.vh-item').length > ${baseCount + 1}`, '回退也记一版', 10000)
        }
        await evaluate(`document.querySelector('.ant-drawer-close')?.click(); true`)
        await sleep(600)
        const back = await evaluate(`document.querySelector('.doc-editor')?.value || ''`)
        if (back === original) {
          console.log('  ✓ 回退后文档内容与改动前一致')
        } else {
          fail(`回退后文档内容未还原（长度 ${back.length} vs ${original.length}）`)
        }
      }
    }
  }

  // ---------------- 分类二：项目文件 ----------------
  console.log('2) 项目文件（文件树 + 对话 + 流程指令）')
  await gotoCat('项目文件')
  // 右栏流程指令清单：6 条指令跨阶段连续编号，含当前阶段高亮（收起态则先展开）
  await evaluate(`document.querySelector('.flow-cmds.closed .fc-head')?.click()`)
  const fcOk = await waitFor(
    `document.querySelectorAll('.fc-row').length >= 6`,
    '流程指令清单渲染',
    6000,
  )
  if (!fcOk) fail('右栏应渲染 6 条流程指令')
  if (!(await waitFor(`document.querySelectorAll('.fp-node').length > 0`, '文件树渲染'))) {
    console.log('   （文件树没渲染出来，跳过本阶段的树断言）')
  } else {
    console.log(`   顶层节点：${JSON.stringify(await nodeNames())}`)
    // 取第一个可展开的目录：antd 给叶子节点配 noop 占位符，没有它的才是目录
    const firstDir = await evaluate(`(() => {
      const el = [...document.querySelectorAll('.ant-tree-treenode')]
        .find(n => n.querySelector('.ant-tree-switcher') && !n.querySelector('.ant-tree-switcher-noop'))
      return el?.querySelector('.fp-name')?.textContent || null
    })()`)
    if (firstDir) {
      if (await expandDir(firstDir)) {
        console.log(`  ✓ 目录「${firstDir}」懒加载展开`)
        console.log(`   展开后节点：${JSON.stringify(await nodeNames())}`)
      } else {
        fail(`目录「${firstDir}」展开后子节点未出现（当前节点：${JSON.stringify(await nodeNames())}）`)
      }
    } else {
      console.log('   （根目录没有可展开的子目录，跳过展开断言）')
    }
  }
  // 悬停出操作按钮：:hover 只认真实指针事件
  const box = await evaluate(`(() => {
    const n = document.querySelector('.fp-node')
    if (!n) return null
    const r = n.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (box) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
    await sleep(350)
    const op = await evaluate(`getComputedStyle(document.querySelector('.fp-node .fp-ops')).opacity`)
    console.log(`   悬停后操作按钮 opacity = ${op}（期望 1）`)
    if (op !== '1') fail(`悬停未显形操作按钮（opacity=${op}）`)
  }
  await shot('ui-2-build.png')

  // 改动页签：平台自己记的 Agent 改动与回退（自定义 pill 页签条）
  if ((await clickByText('.wb-tabs .wb-tab', '改动')) === 'clicked') {
    if (await waitFor(`!!document.querySelector('.chg-pane')`, '改动记录面板', 10000)) {
      // 面板先渲染骨架、再出列表，所以要等列表或空态任一出现再数
      await waitFor(
        `!!document.querySelector('.chg-set') || !!document.querySelector('.chg-pane .ant-empty')`,
        '改动列表加载完成',
        10000,
      )
      const setCount = await count('.chg-set')
      console.log(`   改动记录条数：${setCount}`)
      if (setCount === 0) {
        console.log(
          `   空态提示：${JSON.stringify(
            (await text('.chg-pane .ant-empty-description')).slice(0, 40),
          )}`,
        )
      } else {
        console.log(
          `   统计：${JSON.stringify(
            await evaluate(
              `[...document.querySelectorAll('.chg-set-stats')].slice(0, 3).map(e => e.textContent.trim())`,
            ),
          )}`,
        )
        await evaluate(`document.querySelector('.chg-set-head')?.click(); true`)
        if (await waitFor(`document.querySelectorAll('.chg-file').length > 0`, '改动明细展开', 10000)) {
          console.log(`   明细文件数：${await count('.chg-file')}`)
          await evaluate(`document.querySelector('.chg-file-head')?.click(); true`)
          await waitFor(`!!document.querySelector('.chg-diff')`, '逐行 diff 展开', 8000)
        }
      }
      console.log(`   回退按钮存在：${await evaluate(`!!document.querySelector('.chg-file-ops button')`)}`)
      await shot('ui-2b-changes.png')
    }
  }

  // ---------------- 分类三：用例 ----------------
  console.log('3) 用例（用例 + 附件 + 右侧对话）')
  await gotoCat('用例')
  // 用例分类也有右栏对话（流程指令生成用例草稿 → 对话结束自动导入落库）
  const rightBack = await waitFor(
    `!!document.querySelector('.wb-right .chat-pane')`,
    '右栏对话已渲染',
    6000,
  )
  if (!rightBack) fail('用例分类应有右栏对话（生成用例走对话流式输出）')
  const caseCount = await count('.case-row')
  console.log(`   用例条数：${caseCount}`)
  console.log(`   页头：${JSON.stringify(await text('.case-head'))}`)
  const btnLabels = await evaluate(
    `[...document.querySelectorAll('.case-actions button')].map(b => b.textContent.trim()).filter(Boolean).join('|')`,
  )
  console.log(`   操作按钮：${btnLabels}`)
  if (btnLabels.includes('一键生成') || btnLabels.includes('导入')) {
    fail('一键生成 / 从工作区导入按钮应已移除（生成走右侧对话）')
  }
  console.log(
    `   批量删除按钮存在：${await evaluate(
      `[...document.querySelectorAll('.case-actions button')].some(b => b.textContent.includes('删除选中'))`,
    )}`,
  )
  if (caseCount === 0) console.log('   （演示需求还没有用例，可在右侧对话让 Agent 生成）')
  await shot('ui-3-verify.png')

  // ---------------- 分类四：归档 ----------------
  console.log('4) 归档')
  await gotoCat('归档')
  const cards = await evaluate(
    `[...document.querySelectorAll('.arc-card-head')].map(e => e.textContent.trim())`,
  )
  console.log(`   汇总卡片：${JSON.stringify(cards)}`)
  console.log(`   验收结论区：${await evaluate(`!!document.querySelector('.arc-verdict')`)}`)
  await shot('ui-4-archive.png')

  // ---------------- 收尾：还原进入时的分类 ----------------
  // 冒烟只做走查；左栏分类切换不落库，把页面切回需求文档分类即可。
  console.log('5) 还原左栏 → 需求文档')
  await gotoCat('需求文档')

  console.log(`\nUI 冒烟${fails.length ? `失败 ${fails.length} 项: ${fails.join('; ')}` : '完成 ✅'}`)
  if (fails.length) process.exitCode = 1
} catch (e) {
  console.error(`UI 冒烟失败：${e.message}`)
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
