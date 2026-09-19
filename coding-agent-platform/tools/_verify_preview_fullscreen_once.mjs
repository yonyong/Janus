/** 一次性冒烟：验证文件预览弹窗的全屏交互（按钮切换 + Esc 退出）。 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ARG = process.argv[2]
if (!URL_ARG) { console.error('用法: node tools/_verify_preview_fullscreen_once.mjs "<工作台URL>"'); process.exit(2) }
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
if (!CHROME) { console.error('未找到 Chrome/Edge'); process.exit(3) }

const PORT = 9361
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(tmpdir(), `cap-fs-smoke-${Date.now()}`)}`,
  '--no-first-run', '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' })

const fails = []
const fail = (m) => { fails.push(m); console.log('  ✗ ' + m) }
const ok = (m) => console.log('  ✓ ' + m)

try {
  // 拿 CDP target
  let list = null
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break } catch {}
  }
  if (!list) throw new Error('CDP 未就绪')
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onclose = rej })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails))
    return r.result?.result?.value
  }
  await send('Page.enable')
  await send('Page.navigate', { url: URL_ARG })
  await sleep(6000)

  // 打开文件弹窗：点第一个文件树节点（md/html/代码类才会进预览；找有 .fv- 前景的）
  const opened = await ev(`(async () => {
    const nodes = [...document.querySelectorAll('.fp-tree .ant-tree-treenode')]
    if (!nodes.length) return 'no-tree'
    for (const n of nodes) {
      const name = n.querySelector('.fp-name')?.textContent || ''
      if (/\\.(md|html|java|py|ts|tsx)$/.test(name)) {
        n.querySelector('.ant-tree-node-content-wrapper')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 1500))
        return document.querySelector('.ant-modal-root') ? 'opened:' + name : 'no-modal'
      }
    }
    return 'no-preview-file'
  })()`)
  console.log('打开弹窗:', opened)
  if (!String(opened).startsWith('opened')) fail('未能打开预览弹窗: ' + opened)

  // 点全屏按钮（标题栏里带 Fullscreen 图标的 button）
  const fs1 = await ev(`(async () => {
    const btns = [...document.querySelectorAll('.ant-modal-header button')]
    const btn = btns[btns.length - 1]
    if (!btn) return 'no-btn'
    btn.click()
    await new Promise((r) => setTimeout(r, 800))
    const wrap = document.querySelector('.ant-modal-wrap')
    const content = document.querySelector('.fv-modal-fullscreen .ant-modal-container')
    const isFull = !!document.querySelector('.fv-stage-full')
    const h = content ? content.getBoundingClientRect().height : 0
    let ruleFound = 'cssom-no'
    for (const sheet of document.styleSheets) {
      try {
        for (const r of sheet.cssRules) {
          if (r.cssText && r.cssText.includes('fv-modal-fullscreen')) { ruleFound = 'cssom-yes'; break }
        }
      } catch {}
      if (ruleFound === 'cssom-yes') break
    }
    const cs = content ? getComputedStyle(content) : null
    return JSON.stringify({ isFull, h, ruleFound, display: cs?.display, height: cs?.height })
  })()`)
  console.log('进入全屏:', fs1)
  const s1 = JSON.parse(fs1)
  if (!s1.isFull) fail('全屏类未生效')
  if (s1.ruleFound !== 'cssom-yes') fail('全屏 CSS 规则未加载')
  if (s1.isFull && s1.h < 790) fail(`全屏高度不足: ${s1.h}`)

  // 预览区域高度应撑满（fv-frame / fv-md / fv-code 任一存在则高度应 > 60vh）
  // 预览区域在全屏态下 max-height 应为 calc(100vh - 200px)
  const area = await ev(`(() => {
    const el = document.querySelector('.fv-stage-full .fv-frame, .fv-stage-full .fv-md, .fv-stage-full .fv-code, .fv-stage-full .fv-sheet, .fv-stage-full .fv-docx')
    if (!el) return 'no-area'
    const expect = window.innerHeight - 200
    const got = parseFloat(getComputedStyle(el).maxHeight)
    return JSON.stringify({ expect, got: Math.round(got), ok: Math.abs(got - expect) < 4 })
  })()`)
  console.log('预览区域 max-height:', area)
  const sArea = JSON.parse(area)
  if (!sArea.ok) fail('全屏预览 max-height 未生效: ' + area)

  // Esc 退出全屏（弹窗应保留）
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)
  const fs2 = await ev(`JSON.stringify({
    full: !!document.querySelector('.fv-stage-full'),
    modal: !!document.querySelector('.ant-modal-wrap [role="dialog"]')
  })`)
  console.log('Esc 后:', fs2)
  const s2 = JSON.parse(fs2)
  if (s2.full) fail('Esc 未退出全屏')
  if (!s2.modal) fail('Esc 把整个弹窗关了（应只退全屏）')

  // 再点按钮进全屏，然后点弹窗关闭 → 全屏态复位
  await ev(`(async () => {
    const btns = [...document.querySelectorAll('.ant-modal-header button')]
    btns[btns.length - 1]?.click()
    await new Promise((r) => setTimeout(r, 500))
  })()`)
  const mid = await ev(`!!document.querySelector('.fv-stage-full')`)
  if (!mid) fail('再次进入全屏失败')
  const after = await ev(`(async () => {
    const btns = [...document.querySelectorAll('.ant-modal-footer button')]
    const labels = btns.map((b) => b.textContent)
    const close = btns.find((b) => /关\\s*闭/.test(b.textContent)) || btns[btns.length - 1]
    close?.click()
    await new Promise((r) => setTimeout(r, 2500))
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    return JSON.stringify({
      labels,
      closedLabel: close?.textContent,
      dialogCount: dialogs.length,
      dialogTitles: dialogs.map((d) => (d.querySelector('.ant-modal-title')?.textContent || d.textContent || '').slice(0, 40)),
      stageCount: document.querySelectorAll('.fv-stage-full').length,
      stageAny: document.querySelectorAll('.fv-stage').length,
      confirmVisible: !!document.querySelector('.ant-modal-confirm')
    })
  })()`)
  console.log('关闭后:', after)
  const s3 = JSON.parse(after)
  if (s3.stageCount > 0) fail('关闭后弹窗/全屏态未复位: ' + after)

  console.log(fails.length ? `全屏冒烟完成，${fails.length} 项失败 ❌` : '全屏冒烟完成 ✅')
} catch (e) {
  console.error('脚本异常:', e.message)
  process.exitCode = 1
} finally {
  try { spawn('taskkill', ['/F', '/T', '/PID', String(chrome.pid)]) } catch {}
}
