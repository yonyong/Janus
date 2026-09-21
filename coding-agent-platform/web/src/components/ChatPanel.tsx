import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { App as AntdApp, Button, Dropdown, Input, Tooltip } from 'antd'
import {
  CheckOutlined,
  CloseOutlined,
  DownOutlined,
  FileImageOutlined,
  FileOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { buildMessage, extOf, type ChatAttachment } from '../chatAttachments'
import type { Agent } from '../api'

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

/** 对话输入区：整体是一个圆角输入框（正文 + 内嵌工具条），布局与主流 Agent 输入框一致。
 *  - 左下角 `+`：添加入口（上传文件 / 上传图片 / 唤起常用指令）；
 *  - 右下角：Agent 选择（会话绑定了多个 Agent 时出现）→ 停止 → 发送；
 *  - Enter 发送、Shift+Enter 换行；支持 Ctrl+V 粘贴文件 / 截图。
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
    /** 可选 Agent 列表：多于 1 个时在输入框内展示切换入口。 */
    agents?: Agent[]
    /** 当前会话绑定的 Agent id。 */
    agentId?: number | null
    /** 切换当前会话使用的 Agent。 */
    onChangeAgent?: (agentId: number) => void
    /** 切换 Agent 请求进行中。 */
    agentSwitching?: boolean
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
    agents = [],
    agentId = null,
    onChangeAgent,
    agentSwitching = false,
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
  const imgRef = useRef<HTMLInputElement | null>(null)

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

  /** 把光标移到正文末尾并聚焦（选指令 / 灌草稿后统一收口）。 */
  const focusEnd = () => {
    window.setTimeout(() => {
      const el = taRef.current?.nativeElement as HTMLTextAreaElement | null | undefined
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
  }

  const pickCommand = (c: SlashCommand) => {
    setSlashDismissed(true)
    setMenuIdx(0)
    setV(c.text)
    focusEnd()
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
      focusEnd()
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

  // 左下角 `+` 菜单：统一的「添加内容」入口（上传已有回形针能力都收在这里）
  const plusItems = useMemo(
    () => [
      { key: 'file', icon: <FileOutlined />, label: '上传文件', disabled: !onUpload || busy || uploading },
      { key: 'image', icon: <FileImageOutlined />, label: '上传图片', disabled: !onUpload || busy || uploading },
      { type: 'divider' as const },
      {
        key: 'slash',
        icon: <ThunderboltOutlined />,
        label: '常用指令（/）',
        disabled: busy || commands.length === 0,
      },
    ],
    [onUpload, busy, uploading, commands.length],
  )

  const onPlusClick = ({ key }: { key: string }) => {
    if (key === 'file') {
      fileRef.current?.click()
      return
    }
    if (key === 'image') {
      imgRef.current?.click()
      return
    }
    if (key === 'slash') {
      setSlashDismissed(false)
      setMenuIdx(0)
      setV('/')
      focusEnd()
    }
  }

  const curAgent = agents.find((a) => a.id === agentId) || null
  const showAgentPicker = agents.length > 1 && !!onChangeAgent
  const agentItems = agents.map((a) => ({
    key: String(a.id),
    disabled: a.available === false && a.id !== agentId,
    label: (
      <span className="composer-agent-opt">
        <span className="composer-agent-opt-name">
          {a.name}
          {a.available === false && <em className="composer-agent-opt-tag">今日限额已满</em>}
        </span>
        {a.id === agentId && <CheckOutlined className="composer-agent-opt-check" />}
      </span>
    ),
  }))

  return (
    <div className="composer">
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

      <div className={`composer-box${busy ? ' is-busy' : ''}`}>
        {atts.length > 0 && (
          <div className="composer-atts">
            {atts.map((a) => {
              const isImg = IMG_EXT.has(extOf(a.filename))
              return (
                <span className="composer-att" key={a.path} title={a.path}>
                  {isImg ? <FileImageOutlined /> : <FileOutlined />}
                  <span className="composer-att-name">{a.filename}</span>
                  <button
                    type="button"
                    className="composer-att-x"
                    onClick={() => removeAtt(a.path)}
                    aria-label="移除"
                  >
                    <CloseOutlined />
                  </button>
                </span>
              )
            })}
          </div>
        )}

        <Input.TextArea
          ref={taRef}
          className="composer-input"
          variant="borderless"
          value={v}
          disabled={busy}
          autoSize={{ minRows: 2, maxRows: 8 }}
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
        />

        <div className="composer-tools">
          <div className="composer-tools-l">
            <Dropdown
              trigger={['click']}
              placement="topLeft"
              menu={{ items: plusItems, onClick: onPlusClick }}
            >
              <button
                type="button"
                className="composer-icon-btn"
                title="添加内容"
                aria-label="添加内容"
                disabled={busy}
              >
                {uploading ? <LoadingOutlined /> : <PlusOutlined />}
              </button>
            </Dropdown>
            <span className="composer-hint">
              {uploading ? '正在上传…' : 'Enter 发送 · Shift + Enter 换行 · / 唤起指令'}
            </span>
          </div>

          <div className="composer-tools-r">
            {showAgentPicker && (
              <Dropdown
                trigger={['click']}
                placement="topRight"
                disabled={busy || agentSwitching}
                menu={{
                  items: agentItems,
                  selectable: true,
                  selectedKeys: agentId != null ? [String(agentId)] : [],
                  onClick: ({ key }) => onChangeAgent?.(Number(key)),
                }}
              >
                <button
                  type="button"
                  className="composer-chip composer-agent"
                  title="切换本会话使用的 Agent（会清空 CLI 续聊上下文）"
                  disabled={busy || agentSwitching}
                >
                  {agentSwitching ? <LoadingOutlined /> : <RobotOutlined />}
                  <span className="composer-chip-label">{curAgent?.name || '选择 Agent'}</span>
                  <DownOutlined className="composer-chip-caret" />
                </button>
              </Dropdown>
            )}
            {busy && onAbort && (
              <Tooltip title="停止运行（Alt + .）">
                <button
                  type="button"
                  className="composer-icon-btn is-danger"
                  aria-label="停止运行"
                  disabled={aborting}
                  onClick={onAbort}
                >
                  {aborting ? <LoadingOutlined /> : <PauseCircleOutlined />}
                </button>
              </Tooltip>
            )}
            <Tooltip title={busy ? 'Agent 运行中…' : '发送（Enter）'}>
              {/* 不用 shape="circle"：antd 6 的 .ant-btn-circle 带 min-width:34px 且样式运行时注入，
                  后置覆盖会压不住；圆角与尺寸统一由 .composer-send 接管。 */}
              <Button
                className="composer-send"
                type="primary"
                icon={<SendOutlined />}
                disabled={busy || uploading || (!v.trim() && atts.length === 0)}
                onClick={send}
              />
            </Tooltip>
          </div>
        </div>
      </div>

      <input ref={fileRef} type="file" multiple hidden onChange={onPickFiles} />
      <input ref={imgRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
    </div>
  )
})

export default ChatPanel
