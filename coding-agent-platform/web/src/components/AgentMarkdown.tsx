import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

/** Agent 回复的 Markdown 渲染：标题 / 列表 / 表格 / 代码块 / 行内代码 / 链接等。
 *  与文件预览的 .fv-md 分开，用 .chat-md 承载对话气泡里更紧凑的排版。
 *  渲染后对 pre code 做一次 highlight.js 高亮（样式来自全局 github.css）。 */
marked.setOptions({ gfm: true, breaks: true })

export default function AgentMarkdown({ text }: { text: string }) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(text || '', { async: false }) as string
      return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] })
    } catch {
      return ''
    }
  }, [text])

  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('pre code').forEach((el) => {
      try {
        hljs.highlightElement(el as HTMLElement)
      } catch {
        /* 高亮失败时保留纯文本，不影响阅读 */
      }
    })
    // 链接一律新开页，避免用户在工作台里被导航走
    root.querySelectorAll('a[href]').forEach((el) => {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noreferrer noopener')
    })
  }, [html])

  if (!text) return null
  return <div className="chat-md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}
