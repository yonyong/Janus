import { forwardRef, useImperativeHandle, useRef, useEffect, useState } from 'react'
import { Avatar, Empty, Modal, Space, Spin, Typography } from 'antd'
import {
  ArrowRightOutlined,
  BulbOutlined,
  FileImageOutlined,
  FileOutlined,
  RobotOutlined,
  UserOutlined,
} from '@ant-design/icons'
import ChatPanel, { type ChatPanelHandle } from './ChatPanel'
import RichText from './RichText'
import AgentMarkdown from './AgentMarkdown'
import FilePreview, { previewKindOf, hasPreviewMode } from './FileViewer'
import { parseMessage, extOf, type ChatAttachment } from '../chatAttachments'
import { uploadSessionAttachments, readFile } from '../api'

/** 供父组件（如 Workbench）把快捷指令文本灌入输入框，不自动发送。 */
export interface RequirementPaneHandle {
  loadDraft: (text: string) => void
  focus: () => void
}

export interface ChatMessage {
  role: string
  content: string
}

/** 常用指令：点选后整段填入输入框（由用户手动发送），路径写死为项目目录里的固定文件，避免 Agent 猜。 */
export interface QuickCommand {
  label: string
  /** 一句话说明这条指令会让 Agent 做什么（引导用户点击）。 */
  desc?: string
  text: string
}

/** 一步跑完后的下一步引导：提示文案 + 可选的「进入下一环节」按钮。 */
export interface StepHint {
  text: string
  actionLabel?: string
}

/** 需求窗格：需求元信息 + 对话主线（+ 可选的常用指令条）。 */
const RequirementPane = forwardRef<
  RequirementPaneHandle,
  {
    messages: ChatMessage[]
    busy: boolean
    /** Agent 正在流式输出的正文（实时累积，最终答复到达后清空）。 */
    streamText?: string
    /** 瞬态状态提示（如「调用工具 …」），没有正文在流式时显示。 */
    statusText?: string
    onSend: (text: string) => void
    /** 会话/项目上下文：粘贴文件上传 + 历史消息文件预览用。 */
    sid?: number
    pid?: number | null
    token?: string | null
    /** 常用指令：输入 `/` 时在输入框上方唤起选择菜单（一行一个）。 */
    quickCommands?: QuickCommand[]
    /** 上一步完成后的下一步引导（如「润色完成 → 生成详细设计」）。 */
    stepHint?: StepHint | null
    /** 引导条上「进入下一环节」按钮的回调。 */
    onHintAction?: () => void
    /** Agent 运行中的「真中止」：调用后端中止接口并杀掉 CLI 子进程树。 */
    onAbort?: () => void
    /** 中止请求进行中（按钮转圈，防连点）。 */
    aborting?: boolean
  }
>(function RequirementPane({
  messages,
  busy,
  streamText = '',
  statusText = '',
  onSend,
  sid,
  pid,
  token,
  quickCommands,
  stepHint,
  onHintAction,
  onAbort,
  aborting = false,
}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<ChatPanelHandle>(null)
  // 历史消息文件预览：点击附件 chip 打开
  const [preview, setPreview] = useState<{ path: string; ext: string; content: string; name: string } | null>(null)

  const uploadFiles = sid
    ? async (files: File[]): Promise<ChatAttachment[]> => {
        const rows = await uploadSessionAttachments(token ?? null, sid, files)
        return rows.map((r) => ({ path: r.path, filename: r.filename, size: r.size }))
      }
    : undefined

  const openPreview = async (a: ChatAttachment) => {
    if (pid == null) return
    const ext = extOf(a.filename)
    const kind = previewKindOf(ext)
    const binaryPreview =
      kind === 'pdf' || kind === 'image' || kind === 'sheet' || kind === 'docx' || kind === 'office-legacy'
    let content = ''
    if (!binaryPreview) {
      try {
        content = (await readFile(token ?? null, pid, a.path)).content
      } catch {
        /* 读不到内容时仍打开预览（二进制预览器自行拉取，文本类给下载兜底） */
      }
    }
    setPreview({ path: a.path, ext, content, name: a.filename })
  }

  /** 文件 chip 列表（历史消息 / 预览入口）。 */
  const FileChips = ({ files }: { files: ChatAttachment[] }) => (
    <div className="msg-atts">
      {files.map((a) => {
        const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(extOf(a.filename))
        return (
          <button
            key={a.path}
            type="button"
            className="msg-att"
            title={pid == null ? a.path : `点击预览 · ${a.path}`}
            disabled={pid == null}
            onClick={() => void openPreview(a)}
          >
            {isImg ? <FileImageOutlined /> : <FileOutlined />}
            <span className="msg-att-name">{a.filename}</span>
          </button>
        )
      })}
    </div>
  )

  useImperativeHandle(ref, () => ({
    loadDraft: (text: string) => {
      chatRef.current?.setDraft(text)
    },
    focus: () => chatRef.current?.focus(),
  }))

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, busy, streamText, statusText])

  return (
    <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !busy ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="描述你的需求，Agent 会自动开始拆解与编码"
            style={{ marginTop: 40 }}
          />
        ) : (
          messages.map((m, i) => {
            const isUser = m.role === 'user'
            return (
              <div className={`bubble-row ${isUser ? 'me' : ''}`} key={i}>
                <Avatar
                  size={28}
                  icon={isUser ? <UserOutlined /> : <RobotOutlined />}
                  style={
                    isUser
                      ? { background: '#e8efff', color: '#3370ff' }
                      : { background: 'linear-gradient(135deg,#3370ff,#6ca3ff)', color: '#fff' }
                  }
                />
                <div className={`bubble ${isUser ? 'bubble-me' : 'bubble-agent'}`}>
                  {isUser ? (
                    (() => {
                      const { text, files } = parseMessage(m.content)
                      return (
                        <>
                          {text && <RichText text={text} />}
                          {files.length > 0 && <FileChips files={files} />}
                        </>
                      )
                    })()
                  ) : (
                    <AgentMarkdown text={m.content} />
                  )}
                </div>
              </div>
            )
          })
        )}
        {(busy || streamText) && (
          <div className="bubble-row">
            <Avatar size={28} icon={<RobotOutlined />} style={{ background: 'linear-gradient(135deg,#3370ff,#6ca3ff)' }} />
            <div className="bubble bubble-agent">
              {streamText ? (
                <>
                  <AgentMarkdown text={streamText} />
                  {busy && <span className="stream-caret" aria-hidden />}
                  {busy && statusText && (
                    <div className="stream-status">
                      <Spin size="small" />
                      <span>{statusText}</span>
                    </div>
                  )}
                </>
              ) : (
                <Space size={8}>
                  <Spin size="small" />
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {statusText || 'Agent 正在处理…'}
                  </Typography.Text>
                </Space>
              )}
            </div>
          </div>
        )}
      </div>

      {stepHint && (
        <div className="qc-guide" role="status">
          <span className="qc-guide-icon">
            <BulbOutlined />
          </span>
          <span className="qc-guide-text">{stepHint.text}</span>
          {stepHint.actionLabel && onHintAction && (
            <button type="button" className="qc-guide-btn" onClick={onHintAction}>
              {stepHint.actionLabel}
              <ArrowRightOutlined />
            </button>
          )}
        </div>
      )}

      <ChatPanel
        ref={chatRef}
        busy={busy}
        onSend={onSend}
        commands={quickCommands}
        onUpload={uploadFiles}
        onAbort={onAbort}
        aborting={aborting}
      />

      <Modal
        title={preview?.name}
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={<a onClick={() => setPreview(null)}>关闭</a>}
        width={860}
        destroyOnHidden
      >
        {preview && pid != null && (
          <div className="fv-stage">
            {hasPreviewMode(preview.ext) ? (
              <FilePreview pid={pid} token={token ?? null} path={preview.path} ext={preview.ext} content={preview.content} />
            ) : (
              // 纯文本 / 未知类型没有专门预览器：直接把内容铺在等宽块里
              <pre className="code-block" style={{ maxHeight: '58vh' }}>
                {preview.content || '（空文件或内容不可预览）'}
              </pre>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
})

export default RequirementPane
