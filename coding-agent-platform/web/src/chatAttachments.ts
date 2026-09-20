/** 对话消息里的文件附件：既要能被 Agent 直接读取（项目内相对路径），
 *  也要能在历史消息里点开预览。做法是把附件以一段可解析的标记块追加到消息文本里：
 *
 *    <用户输入的正文>
 *
 *    [[janus:files]]
 *    - .janus/{dir}/chat/attach/a.png | a.png
 *    - .janus/{dir}/chat/attach/b.pdf | b.pdf
 *
 *  只对「用户消息」解析这段块（附件只可能由用户粘贴/选择），渲染时把正文与文件 chip
 *  分开；Agent 收到的原始消息里同样带着这些路径，可直接读取。 */
export interface ChatAttachment {
  path: string
  filename: string
  size?: number
}

export const ATTACH_MARKER = '[[janus:files]]'

/** 把正文与附件拼成最终消息文本（无附件时原样返回正文）。 */
export function buildMessage(text: string, atts: ChatAttachment[]): string {
  const body = (text || '').trim()
  if (!atts.length) return body
  const lines = atts.map((a) => `- ${a.path} | ${a.filename}`).join('\n')
  const block = `${ATTACH_MARKER}\n${lines}`
  return body ? `${body}\n\n${block}` : block
}

/** 从消息文本里拆出正文与附件列表（没有标记块时 files 为空、text 原样）。 */
export function parseMessage(content: string): { text: string; files: ChatAttachment[] } {
  const raw = content || ''
  const idx = raw.indexOf(ATTACH_MARKER)
  if (idx < 0) return { text: raw, files: [] }
  const text = raw.slice(0, idx).replace(/\n+$/, '')
  const rest = raw.slice(idx + ATTACH_MARKER.length)
  const files: ChatAttachment[] = []
  for (const line of rest.split('\n')) {
    const l = line.trim()
    if (!l.startsWith('- ')) continue
    const body = l.slice(2)
    const sep = body.lastIndexOf(' | ')
    const path = (sep >= 0 ? body.slice(0, sep) : body).trim()
    const filename = (sep >= 0 ? body.slice(sep + 3) : body).trim() || path
    if (path) files.push({ path, filename })
  }
  return { text, files }
}

/** 扩展名（小写，无点）。 */
export function extOf(name: string): string {
  const i = (name || '').lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}
