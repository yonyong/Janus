import { forwardRef, useImperativeHandle, useRef, useEffect, useState } from 'react'
import { Avatar, Empty, Space, Spin, Typography } from 'antd'
import {
  ArrowRightOutlined,
  BulbOutlined,
  DownOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons'
import ChatPanel, { type ChatPanelHandle } from './ChatPanel'
import RichText from './RichText'
import AgentMarkdown from './AgentMarkdown'

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
    /** 非空时在输入框上方渲染常用指令按钮（编码实现阶段使用）。 */
    quickCommands?: QuickCommand[]
    /** 上一步完成后的下一步引导（如「润色完成 → 生成详细设计」）。 */
    stepHint?: StepHint | null
    /** 引导条上「进入下一环节」按钮的回调。 */
    onHintAction?: () => void
    /** 引导用户点击的快捷指令 label，对应卡片高亮。 */
    highlightCommand?: string
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
  quickCommands,
  stepHint,
  onHintAction,
  highlightCommand,
  onAbort,
  aborting = false,
}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<ChatPanelHandle>(null)
  // 常用指令条默认展开，用户可收起（避免长指令占用输入区上方空间）
  const [qcOpen, setQcOpen] = useState(true)

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
                  {isUser ? <RichText text={m.content} /> : <AgentMarkdown text={m.content} />}
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

      {quickCommands && quickCommands.length > 0 && (
        <div className={`quick-commands${qcOpen ? '' : ' is-closed'}`}>
          <button type="button" className="qc-head qc-head-btn" onClick={() => setQcOpen((o) => !o)}>
            <span className="qc-head-icon">
              <ThunderboltOutlined />
            </span>
            <span className="qc-head-title">常用指令</span>
            <span className="qc-head-hint">点一下填入输入框，确认无误后手动发送</span>
            <DownOutlined className="qc-head-caret" />
          </button>
          {qcOpen && (
            <div className="qc-list">
              {quickCommands.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className={`qc-chip${highlightCommand === c.label ? ' is-highlight' : ''}`}
                  disabled={busy}
                  title={c.text}
                  onClick={() => chatRef.current?.setDraft(c.text)}
                >
                  <span className="qc-chip-title">{c.label}</span>
                  {c.desc && <span className="qc-chip-desc">{c.desc}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <ChatPanel ref={chatRef} busy={busy} onSend={onSend} onAbort={onAbort} aborting={aborting} />
    </div>
  )
})

export default RequirementPane
