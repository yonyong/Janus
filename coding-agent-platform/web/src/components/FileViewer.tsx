/** 文件预览渲染器：按扩展名分流到对应的预览实现。
 *
 * 文本类（md / html / 代码）由 FilePane 先通过 readFile 读好文本再传进来；
 * 二进制类（pdf / 图片 / 表格 / docx）在本组件内经 /file/raw 拉取原始字节流。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Spin, Typography } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import * as XLSX from 'xlsx'
import { renderAsync } from 'docx-preview'
import hljs from 'highlight.js/lib/common'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { fileRawPathUrl, fileRawUrl } from '../api'
import 'highlight.js/styles/github.css'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export type PreviewKind =
  | 'pdf'
  | 'image'
  | 'sheet'
  | 'docx'
  | 'html'
  | 'md'
  | 'code'
  | 'office-legacy'
  | 'text'
  | 'unknown'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'])
const SHEET_EXTS = new Set(['xlsx', 'xls', 'csv'])
const LEGACY_OFFICE_EXTS = new Set(['doc', 'ppt', 'pptx', 'wps'])

/** 扩展名 → highlight.js 语言（只映射 lib/common 内置的，避免按需拉语言包）。 */
const CODE_LANG: Record<string, string> = {
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  xml: 'xml', json: 'json', yaml: 'yaml', yml: 'yaml', ini: 'ini', toml: 'ini',
  css: 'css', scss: 'scss', less: 'less',
  lua: 'lua', r: 'r', pl: 'perl', vb: 'vbnet', mk: 'makefile', diff: 'diff',
}

/** 按扩展名判断预览类型；'text' 走纯文本编辑，'unknown' 尝试按文本读、读不动就报二进制。 */
export function previewKindOf(ext: string): PreviewKind {
  const e = (ext || '').toLowerCase()
  if (e === 'pdf') return 'pdf'
  if (IMAGE_EXTS.has(e)) return 'image'
  if (SHEET_EXTS.has(e)) return 'sheet'
  if (e === 'docx') return 'docx'
  if (LEGACY_OFFICE_EXTS.has(e)) return 'office-legacy'
  if (e === 'html' || e === 'htm') return 'html'
  if (e === 'md' || e === 'markdown') return 'md'
  if (CODE_LANG[e]) return 'code'
  return 'text'
}

/** 是否有「预览」形态（决定弹窗里是否出现 预览/源码 切换）。 */
export function hasPreviewMode(ext: string): boolean {
  const k = previewKindOf(ext)
  return k !== 'text' && k !== 'unknown'
}

function DownloadButton({ pid, token, path }: { pid: number; token: string | null; path: string }) {
  return (
    <Button size="small" icon={<DownloadOutlined />} href={fileRawUrl(token, pid, path, true)}>
      下载
    </Button>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 40, textAlign: 'center' }}>{children}</div>
}

/* ---------------- PDF / 图片：浏览器原生渲染 ---------------- */

function NativePreview({
  pid,
  token,
  path,
  kind,
  fullscreen,
}: {
  pid: number
  token: string | null
  path: string
  kind: 'pdf' | 'image'
  fullscreen?: boolean
}) {
  const src = useMemo(() => fileRawUrl(token, pid, path), [pid, token, path])
  if (kind === 'image') {
    return (
      <div style={{ textAlign: 'center' }}>
        <img
          src={src}
          alt={path}
          style={{ maxWidth: '100%', maxHeight: fullscreen ? 'calc(100vh - 220px)' : '58vh', borderRadius: 8 }}
        />
      </div>
    )
  }
  return <iframe title={path} src={src} className="fv-frame" />
}

/* ---------------- 表格：xlsx / xls（二进制拉取）、csv（文本直接解析） ---------------- */

const SHEET_MAX_ROWS = 200
const SHEET_MAX_COLS = 40

function SheetPreview({
  pid,
  token,
  path,
  ext,
  content,
}: {
  pid: number
  token: string | null
  path: string
  ext: string
  content: string
}) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [rows, setRows] = useState<string[][]>([])
  const [note, setNote] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    ;(async () => {
      try {
        let wb: XLSX.WorkBook
        if (ext === 'csv') {
          wb = XLSX.read(content || '', { type: 'string' })
        } else {
          const res = await fetch(fileRawUrl(token, pid, path))
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
        }
        const name = wb.SheetNames[0]
        const all = (XLSX.utils.sheet_to_json(wb.Sheets[name], {
          header: 1,
          defval: '',
          raw: false,
        }) as unknown[][]).map((r) => r.map((c) => String(c ?? '')))
        if (!alive) return
        const cut = all.slice(0, SHEET_MAX_ROWS).map((r) => r.slice(0, SHEET_MAX_COLS))
        setRows(cut)
        if (all.length > SHEET_MAX_ROWS)
          setNote(`仅显示前 ${SHEET_MAX_ROWS} 行（共 ${all.length} 行）`)
        else if (cut.some((r) => r.length >= SHEET_MAX_COLS))
          setNote(`仅显示前 ${SHEET_MAX_COLS} 列`)
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [pid, token, path, ext, content])

  if (loading)
    return (
      <Center>
        <Spin tip="正在解析表格…" />
      </Center>
    )
  if (err)
    return (
      <Alert
        type="warning"
        showIcon
        message="表格解析失败"
        description={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>{err}</span>
            <DownloadButton pid={pid} token={token} path={path} />
          </div>
        }
      />
    )
  if (rows.length === 0) return <Center><Typography.Text type="secondary">空表格</Typography.Text></Center>
  const [head, ...body] = rows
  return (
    <div>
      {note && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          {note}
        </Typography.Text>
      )}
      <div className="fv-sheet">
        <table>
          <thead>
            <tr>
              {head.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- Word 文档：docx-preview 渲染 ---------------- */

function DocxPreview({
  pid,
  token,
  path,
}: {
  pid: number
  token: string | null
  path: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    ;(async () => {
      try {
        const res = await fetch(fileRawUrl(token, pid, path))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        if (!alive || !boxRef.current) return
        boxRef.current.innerHTML = ''
        await renderAsync(buf, boxRef.current, undefined, { inWrapper: true })
        if (alive) setLoading(false)
      } catch (e) {
        if (alive) {
          setErr(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [pid, token, path])

  if (err)
    return (
      <Alert
        type="warning"
        showIcon
        message="文档渲染失败"
        description={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>{err}</span>
            <DownloadButton pid={pid} token={token} path={path} />
          </div>
        }
      />
    )
  return (
    <div style={{ position: 'relative' }}>
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', paddingTop: 48 }}>
          <Spin tip="正在解析文档…" />
        </div>
      )}
      <div ref={boxRef} className="fv-docx" style={{ visibility: loading ? 'hidden' : 'visible' }} />
    </div>
  )
}

/* ---------------- 代码：highlight.js 语法渲染 ---------------- */

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function CodeView({ code, ext }: { code: string; ext: string }) {
  const html = useMemo(() => {
    const lang = CODE_LANG[(ext || '').toLowerCase()]
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
      return hljs.highlightAuto(code).value
    } catch {
      return escapeHtml(code)
    }
  }, [code, ext])
  return (
    <pre className="fv-code">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

/* ---------------- Markdown：marked + DOMPurify ---------------- */

function MarkdownView({ content }: { content: string }) {
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(content, { async: false }) as string)
    } catch {
      return escapeHtml(content)
    }
  }, [content])
  return <div className="fv-md" dangerouslySetInnerHTML={{ __html: html }} />
}

/* ---------------- 总入口 ---------------- */

export default function FilePreview({
  pid,
  token,
  path,
  ext,
  content,
  fullscreen,
}: {
  pid: number
  token: string | null
  path: string
  ext: string
  /** 已读好的文本内容（md / html / 代码 / csv 用）。 */
  content: string
  /** 宿主弹窗处于全屏态：预览区域改用视口高度撑满。 */
  fullscreen?: boolean
}) {
  const kind = previewKindOf(ext)
  switch (kind) {
    case 'pdf':
    case 'image':
      return <NativePreview pid={pid} token={token} path={path} kind={kind} fullscreen={fullscreen} />
    case 'sheet':
      return <SheetPreview pid={pid} token={token} path={path} ext={ext} content={content} />
    case 'docx':
      return <DocxPreview pid={pid} token={token} path={path} />
    case 'office-legacy':
      return (
        <Alert
          type="info"
          showIcon
          message="该格式暂不支持在线预览"
          description={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>可下载后用本地 Office / WPS 打开。</span>
              <DownloadButton pid={pid} token={token} path={path} />
            </div>
          }
        />
      )
    case 'html':
      // 路径内嵌 raw URL：iframe 里的相对引用能自然解析；sandbox 只放行脚本，
      // 不给 same-origin，页面脚本无法触碰工作台本身。
      return <iframe title={path} src={fileRawPathUrl(token, pid, path)} sandbox="allow-scripts" className="fv-frame" />
    case 'md':
      return <MarkdownView content={content} />
    case 'code':
      return <CodeView code={content} ext={ext} />
    default:
      return null
  }
}

/** 供文件树图标用的分组判断（避免 FilePane 重复维护扩展名清单）。 */
export const previewGroups = { IMAGE_EXTS, SHEET_EXTS, LEGACY_OFFICE_EXTS, CODE_LANG }
