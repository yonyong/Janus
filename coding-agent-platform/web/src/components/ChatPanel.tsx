import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { App as AntdApp, Button, Input, Tooltip, Typography } from 'antd'
import {
  CloseOutlined,
  FileImageOutlined,
  FileOutlined,
  LoadingOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  SendOutlined,
} from '@ant-design/icons'
import { buildMessage, extOf, type ChatAttachment } from '../chatAttachments'

/** 供父组件把快捷指令等文本灌入输入框（不自动发送，等用户手动确认）。 */
export interface ChatPanelHandle {
  setDraft: (text: string) => void
  focus: () => void
}

/** 斜杠菜单里的一条常用指令。 */
export interface SlashCommand {
  label: string
  desc?: string
  text: string
}

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

/** 对话输入区：Enter 发送、Shift+Enter 换行；支持 Ctrl+V 粘贴文件 / 点击回形针选择文件，
 *  文件先上传到工作区，随消息一并发出（Agent 可直接读取，历史消息里也能预览）。
 *  Agent 运行中提供「真中止」停止按钮。 */
const ChatPanel = forwardRef<
  ChatPanelHandle,
  {
    busy: boolean
    onSend: (text: string) => void
    placeholder?: string
    /** 常用指令：输入 `/` 时在输入框上方唤起一行一个的选择菜单。 */
    commands?: SlashCommand[]
    /** 上传粘贴/选择的文件，返回落盘后的附件（含项目内相对路径）。 */
    onUpload?: (files: File[]) => Promise<ChatAttachment[]>
    /** Agent 运行中可点「停止」：调用后端中止接口，杀掉 CLI 子进程树（真中止）。 */
    onAbort?: () => void
    /** 中止请求进行中（按钮转圈，防连点）。 */
    aborting?: boolean
  }
>(function ChatPanel(
  {
    busy,
    onSend,
    placeholder = '描述需求，召唤编码 Agent…（输入 / 唤起常用指令，可 Ctrl+V 粘贴文件）',
    commands = [],
    onUpload,
    onAbort,
    aborting = false,
  },
  ref,
) {
  const { message } = AntdApp.useApp()
  const [v, setV] = useState('')
  const [atts, setAtts] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  // 斜杠菜单：输入以 / 开头时唤起；menuIdx 为高亮项，dismissed 记录用户按 Esc 主动关闭
  const [menuIdx, setMenuIdx] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const taRef = useRef<React.ComponentRef<typeof Input.TextArea> | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // 以 / 开头 → 取 / 后的关键词过滤常用指令（匹配标题或说明）
  const slashQuery = v.startsWith('/') ? v.slice(1).trim().toLowerCase() : null
  const slashFiltered =
    slashQuery !== null && !busy
      ? commands.filter(
          (c) =>
            !slashQuery ||
            c.label.toLowerCase().includes(slashQuery) ||
            (c.desc || '').toLowerCase().includes(slashQuery),
        )
      : []
  const menuOpen = !slashDismissed && slashFiltered.length > 0
  const activeIdx = Math.min(menuIdx, Math.max(0, slashFiltered.length - 1))

  const pickCommand = (c: SlashCommand) => {
    setSlashDismissed(true)
    setMenuIdx(0)
    setV(c.text)
    window.setTimeout(() => {
      const el = taRef.current?.nativeElement as HTMLTextAreaElement | null | undefined
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
  }

  const onChangeValue = (next: string) => {
    setV(next)
    // 值不再以 / 开头时清掉「已关闭」标记，下次再输入 / 能重新唤起
    if (!next.startsWith('/')) setSlashDismissed(false)
    setMenuIdx(0)
  }

  useImperativeHandle(ref, () => ({
    setDraft: (text: string) => {
      setV(text)
      window.setTimeout(() => {
        const el = taRef.current?.nativeElement as HTMLTextAreaElement | null | undefined
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }, 0)
    },
    focus: () => taRef.current?.focus(),
  }))

  /** 给无名文件（粘贴的截图常无文件名）按 MIME 类型补一个带扩展名的名字，
   *  这样落盘后能按后缀识别为图片并预览。 */
  const namedFile = (f: File, i: number): File => {
    if (f.name) return f
    const sub = (f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg')
    return new File([f], `pasted-${Date.now()}-${i}.${sub}`, { type: f.type })
  }

  const doUpload = async (files: File[]) => {
    if (!files.length) return
    if (!onUpload) {
      message.warning('当前会话不支持上传文件')
      return
    }
    setUploading(true)
    try {
      const rows = await onUpload(files.map(namedFile))
      setAtts((cur) => [...cur, ...rows])
    } catch (e: any) {
      message.error('文件上传失败：' + String(e?.message || e))
    } finally {
      setUploading(false)
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const dt = e.clipboardData
    if (!dt) return
    // 粘贴的文件可能在 files（拷贝的文件）里，也可能只在 items（截图等图片 blob）里
    let files = Array.from(dt.files || [])
    if (files.length === 0 && dt.items) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === 'file') {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      }
    }
    if (files.length) {
      // 有文件（含截图）时拦下默认粘贴，改为上传；纯文本粘贴不受影响
      e.preventDefault()
      void doUpload(files)
    }
  }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    void doUpload(files)
    e.target.value = ''
  }

  const removeAtt = (path: string) => setAtts((cur) => cur.filter((a) => a.path !== path))

  const send = () => {
    const t = v.trim()
    if ((!t && atts.length === 0) || busy || uploading) return
    onSend(buildMessage(t, atts))
    setV('')
    setAtts([])
  }

  return (
    <div className="composer">
      {atts.length > 0 && (
        <div className="composer-atts">
          {atts.map((a) => {
            const isImg = IMG_EXT.has(extOf(a.filename))
            return (
              <span className="composer-att" key={a.path} title={a.path}>
                {isImg ? <FileImageOutlined /> : <FileOutlined />}
                <span className="composer-att-name">{a.filename}</span>
                <button type="button" className="composer-att-x" onClick={() => removeAtt(a.path)} aria-label="移除">
                  <CloseOutlined />
                </button>
              </span>
            )
          })}
        </div>
      )}
      {menuOpen && (
        <div className="slash-menu" role="listbox">
          <div className="slash-menu-head">常用指令 · 数字键快速选 · ↑↓ · Enter · Esc</div>
          {slashFiltered.map((c, i) => (
            <button
              key={c.label}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              className={`slash-item${i === activeIdx ? ' is-active' : ''}`}
              onMouseEnter={() => setMenuIdx(i)}
              onClick={() => pickCommand(c)}
            >
              <span className="slash-item-num">{i + 1}</span>
              <span className="slash-item-name">{c.label}</span>
              {c.desc && <span className="slash-item-desc">{c.desc}</span>}
            </button>
          ))}
        </div>
      )}
      <Input.TextArea
        ref={taRef}
        value={v}
        disabled={busy}
        autoSize={{ minRows: 2, maxRows: 6 }}
        placeholder={busy ? 'Agent 正在处理…' : placeholder}
        onChange={(e) => onChangeValue(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (menuOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setMenuIdx((i) => (Math.min(i, slashFiltered.length - 1) + 1) % slashFiltered.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setMenuIdx((i) => {
                const cur = Math.min(i, slashFiltered.length - 1)
                return (cur - 1 + slashFiltered.length) % slashFiltered.length
              })
              return
            }
            if (/^[1-9]$/.test(e.key)) {
              const idx = Number(e.key) - 1
              if (idx < slashFiltered.length) {
                e.preventDefault()
                pickCommand(slashFiltered[idx])
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              pickCommand(slashFiltered[activeIdx])
              return
            }
            if (e.key === 'Tab') {
              e.preventDefault()
              pickCommand(slashFiltered[activeIdx])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setSlashDismissed(true)
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        style={{ borderRadius: 10 }}
      />
      <input ref={fileRef} type="file" multiple hidden onChange={onPickFiles} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tooltip title="添加文件（也可 Ctrl+V 粘贴）">
            <Button
              size="small"
              type="text"
              icon={uploading ? <LoadingOutlined /> : <PaperClipOutlined />}
              disabled={busy || uploading || !onUpload}
              onClick={() => fileRef.current?.click()}
            />
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {uploading ? '正在上传…' : 'Enter 发送 · Shift + Enter 换行 · / 唤起指令'}
          </Typography.Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {busy && onAbort && (
            <Button danger icon={<PauseCircleOutlined />} loading={aborting} onClick={onAbort}>
              停止运行
            </Button>
          )}
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={busy}
            disabled={busy || uploading || (!v.trim() && atts.length === 0)}
            onClick={send}
          >
            发送
          </Button>
        </div>
      </div>
    </div>
  )
})

export default ChatPanel
