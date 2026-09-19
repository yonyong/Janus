/**
 * 文件预览 UI 冒烟：用本机 Chrome/Edge（headless + CDP）真实渲染工作台文件弹窗。
 *
 * 覆盖（工作台「我的文件」预览体系的核心承诺）：
 *   1. html → 默认预览（iframe srcDoc 渲染），可切「源码」编辑，再切回预览
 *   2. md  → 默认预览（.fv-md 渲染）
 *   3. 代码文件（.java）→ 默认「语法高亮」（highlight.js .fv-code），可切「源码」
 *      （.java 文件由本脚本经 API 临时创建，跑完删除，不留演示数据）
 *
 * 前置：后端已在本机运行；传入带 token 的工作台 URL（会话需挂在一个真实项目上）。
 * 用法：
 *   node tools/ui_smoke_preview.mjs "<带 token 的工作台 URL>" [输出目录] [base地址]
 * 产出（默认 .ui-smoke/）：preview-html.png preview-md.png preview-java.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const URL_ARG = process.argv[2]
const OUT_DIR = process.argv[3] && !process.argv[3].startsWith('http')
  ? process.argv[3]
  : join(process.cwd(), '.ui-smoke')
const BASE = (process.argv[3] && process.argv[3].startsWith('http') ? process.argv[3] : process.argv[4])
  || new URL(URL_ARG).origin
if (!URL_ARG) {
  console.error('用法: node tools/ui_smoke_preview.mjs "<带 token 的工作台 URL>" [输出目录] [base地址]')
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

const PORT = 9360
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

async function clickStep(label) {
  const r = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.wb-flow .ant-steps-item')]
    const hit = items.find(el => el.querySelector('.ant-steps-item-title')?.textContent?.includes(${JSON.stringify(label)}))
    if (!hit) return 'not-found'
    const target = hit.querySelector('.ant-steps-item-container') || hit
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  if (r !== 'clicked') fail(`点击工作流节点「${label}」失败：${r}`)
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

async function clickByText(sel, label) {
  const r = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find(e => (e.textContent || '').trim() === ${JSON.stringify(label)})
    if (!el) return 'not-found'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
  if (r !== 'clicked') fail(`点击「${label}」失败：${r}`)
  return r
}

async function closeModal() {
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.ant-modal .ant-btn')]
      .find(b => (b.textContent || '').trim() === '关 闭' || (b.textContent || '').trim() === '关闭')
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  })()`)
  await sleep(400)
}

async function main() {
  // 等 CDP 端口就绪并连上页面
  let target
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch { /* chrome 未起好 */ }
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
    if (!p) return
    pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error.message))
    else p.resolve(m)
  })
  await send('Page.enable')
  await sleep(1500)

  // 进入编码实现阶段，等文件树
  await waitFor(`!!document.querySelector('.wb-flow')`, '工作流节点条出现')
  await clickStep('编码实现')
  await waitFor(`document.querySelectorAll('.fp-node').length > 0`, '文件树渲染')

  // ---------- 1) html：预览 + 源码 ----------
  console.log('1) html 预览 / 源码')
  await clickNode('snake.html')
  await waitFor(`!!document.querySelector('.ant-modal .fv-frame')`, '默认进入预览（iframe 渲染）')
  const srcOk = await evaluate(
    `(()=>{const f=document.querySelector('.ant-modal .fv-frame');return f?(f.src||'').includes('/raw/snake.html'):'no-frame'})()`)
  if (srcOk === true) console.log('  ✓ iframe 指向 raw 嵌套路由（相对资源可解析）')
  else fail(`iframe src 异常：${srcOk}`)
  const segHtml = await evaluate(
    `[...document.querySelectorAll('.ant-modal .ant-segmented-item')].map(e=>e.textContent)`)
  if (JSON.stringify(segHtml) === JSON.stringify(['预览', '源码'])) console.log('  ✓ 提供 预览/源码 切换')
  else fail(`分段控件异常：${JSON.stringify(segHtml)}`)
  await shot('preview-html.png')
  await clickByText('.ant-modal .ant-segmented-item', '源码')
  await waitFor(`!!document.querySelector('.ant-modal textarea')`, '切到源码（textarea 可编辑）')
  await clickByText('.ant-modal .ant-segmented-item', '预览')
  await waitFor(`!!document.querySelector('.ant-modal .fv-frame')`, '切回预览')
  await closeModal()

  // ---------- 2) md：预览 ----------
  console.log('2) md 预览')
  await clickNode('AGENT_CHANGES.md')
  await waitFor(`!!document.querySelector('.ant-modal .fv-md')`, '默认进入 Markdown 预览')
  const mdSeg = await evaluate(
    `[...document.querySelectorAll('.ant-modal .ant-segmented-item')].map(e=>e.textContent)`)
  if (JSON.stringify(mdSeg) === JSON.stringify(['预览', '源码'])) console.log('  ✓ 提供 预览/源码 切换')
  else fail(`md 分段控件异常：${JSON.stringify(mdSeg)}`)
  await shot('preview-md.png')
  await closeModal()

  // ---------- 3) 代码（临时建 .java）：语法高亮 ----------
  console.log('3) java 语法高亮')
  const m = URL_ARG.match(/workbench\/(\d+)/)
  const sessId = m ? Number(m[1]) : null
  let created = false
  if (sessId) {
    const sess = await fetch(`${BASE}/api/sessions/${sessId}?${new URL(URL_ARG).searchParams}`)
      .then((r) => r.json()).catch(() => null)
    const pid = sess?.project_id
    const tk = new URL(URL_ARG).searchParams.get('token')
    if (pid && tk) {
      const code = [
        'import java.util.List;',
        '',
        'public class PreviewSmoke {',
        '    private final String name;',
        '    public PreviewSmoke(String name) { this.name = name; }',
        '    public static void main(String[] args) {',
        '        List<String> xs = List.of("a", "b");',
        '        System.out.println("hello " + xs.size());',
        '    }',
        '}',
      ].join('\n')
      const r = await fetch(`${BASE}/api/projects/${pid}/file?token=${tk}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'PreviewSmoke.java', content: code }),
      }).then((r) => r.status).catch(() => 0)
      created = r === 200
      if (!created) fail(`临时 .java 创建失败（HTTP ${r}）`)
    }
  }
  if (created) {
    // 刷新页面让文件树重新拉取（FilePane 的树刷新由 Agent 改动信号驱动，这里直接重载）
    await evaluate(`location.reload()`)
    await sleep(2500)
    await waitFor(`!!document.querySelector('.wb-flow')`, '页面重载完成')
    await clickStep('编码实现')
    await waitFor(`document.querySelectorAll('.fp-node').length > 0`, '文件树重新渲染')
    await clickNode('PreviewSmoke.java')
    await waitFor(`!!document.querySelector('.ant-modal pre.fv-code code .hljs-keyword')`,
      '默认进入语法高亮（hljs 关键字已着色）')
    const codeSeg = await evaluate(
      `[...document.querySelectorAll('.ant-modal .ant-segmented-item')].map(e=>e.textContent)`)
    if (JSON.stringify(codeSeg) === JSON.stringify(['语法高亮', '源码'])) console.log('  ✓ 提供 语法高亮/源码 切换')
    else fail(`代码分段控件异常：${JSON.stringify(codeSeg)}`)
    await shot('preview-java.png')
    await closeModal()
    // 清理临时文件
    const pid = await fetch(`${BASE}/api/sessions/${sessId}?${new URL(URL_ARG).searchParams}`)
      .then((r) => r.json()).then((j) => j.project_id)
    const tk = new URL(URL_ARG).searchParams.get('token')
    await fetch(`${BASE}/api/projects/${pid}/files?token=${tk}&path=PreviewSmoke.java`, { method: 'DELETE' })
    console.log('  ✓ 临时 .java 已清理')
  }

  // ---------- 4) xlsx 表格预览（临时生成真 xlsx 写入项目磁盘） ----------
  console.log('4) xlsx 表格预览')
  if (sessId) {
    const qs = new URL(URL_ARG).searchParams
    const sess = await fetch(`${BASE}/api/sessions/${sessId}?${qs}`).then((r) => r.json()).catch(() => null)
    if (sess?.disk_path && existsSync(sess.disk_path)) {
      const req = createRequire(new URL('../web/package.json', import.meta.url))
      const XLSX = req('xlsx')
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([['姓名', '分数'], ['张三', 95], ['李四', 88], ['王五', 76]]),
        '成绩',
      )
      const xlsxPath = join(sess.disk_path, 'PreviewSmoke.xlsx')
      writeFileSync(xlsxPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
      await evaluate(`location.reload()`)
      await sleep(2500)
      await waitFor(`!!document.querySelector('.wb-flow')`, '页面重载完成')
      await clickStep('编码实现')
      await waitFor(`document.querySelectorAll('.fp-node').length > 0`, '文件树重新渲染')
      await clickNode('PreviewSmoke.xlsx')
      await waitFor(`!!document.querySelector('.ant-modal .fv-sheet table')`, '默认进入表格预览（SheetJS 解析）')
      const cellText = await evaluate(
        `document.querySelector('.ant-modal .fv-sheet')?.textContent || ''`)
      if (cellText.includes('张三') && cellText.includes('95')) console.log('  ✓ 单元格内容正确（张三/95）')
      else fail(`表格内容异常：${cellText.slice(0, 60)}`)
      await shot('preview-xlsx.png')
      await closeModal()
      try { rmSync(xlsxPath, { force: true }) } catch { /* ignore */ }
      console.log('  ✓ 临时 .xlsx 已清理')
    } else {
      console.log('  （会话未暴露磁盘路径或路径不存在，跳过 xlsx 用例）')
    }
  }

  console.log('\n' + (fails.length === 0 ? '文件预览 UI 冒烟完成 ✅' : `预览冒烟失败 ${fails.length} 项：${fails.join('；')}`))
  process.exitCode = fails.length === 0 ? 0 : 1
}

main().finally(async () => {
  try { ws?.close() } catch { /* ignore */ }
  chrome.kill()
  // Windows 下 Chrome 退出释放 profile 有延迟，稍等再清；失败不影响结果
  setTimeout(() => {
    try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* EBUSY 可容忍 */ }
  }, 1500)
})
