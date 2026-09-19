import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Button, Input, Typography } from 'antd'
import { PauseCircleOutlined, SendOutlined } from '@ant-design/icons'

/** 供父组件把快捷指令等文本灌入输入框（不自动发送，等用户手动确认）。 */
export interface ChatPanelHandle {
  setDraft: (text: string) => void
  focus: () => void
}

/** 对话输入区：Enter 发送、Shift+Enter 换行；Agent 运行中提供「真中止」停止按钮。 */
const ChatPanel = forwardRef<
  ChatPanelHandle,
  {
    busy: boolean
    onSend: (text: string) => void
    placeholder?: string
    /** Agent 运行中可点「停止」：调用后端中止接口，杀掉 CLI 子进程树（真中止）。 */
    onAbort?: () => void
    /** 中止请求进行中（按钮转圈，防连点）。 */
    aborting?: boolean
  }
>(function ChatPanel(
  { busy, onSend, placeholder = '描述需求，召唤编码 Agent…', onAbort, aborting = false },
  ref,
) {
  const [v, setV] = useState('')
  const taRef = useRef<React.ComponentRef<typeof Input.TextArea> | null>(null)

  useImperativeHandle(ref, () => ({
    setDraft: (text: string) => {
      setV(text)
      // 等 React 把新值写进 DOM 后再聚焦，光标落在文本末尾
      window.setTimeout(() => {
        const el = taRef.current?.nativeElement as HTMLTextAreaElement | null | undefined
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }, 0)
    },
    focus: () => taRef.current?.focus(),
  }))

  const send = () => {
    const t = v.trim()
    if (!t || busy) return
    setV('')
    onSend(t)
  }

  return (
    <div className="composer">
      <Input.TextArea
        ref={taRef}
        value={v}
        disabled={busy}
        autoSize={{ minRows: 2, maxRows: 6 }}
        placeholder={busy ? 'Agent 正在处理…' : placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        style={{ borderRadius: 10, background: '#fff' }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 8,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Enter 发送 · Shift + Enter 换行
        </Typography.Text>
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
            disabled={busy || !v.trim()}
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
