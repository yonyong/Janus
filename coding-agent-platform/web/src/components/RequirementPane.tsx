import ChatPanel from './ChatPanel'

// 需求窗格：展示需求元信息 + 对话主线（用户/agent 消息）。
export default function RequirementPane({
  requirement,
  messages,
  busy,
  onSend,
}: {
  requirement: { title?: string; description?: string } | null
  messages: { role: string; content: string }[]
  busy: boolean
  onSend: (text: string) => void
}) {
  return (
    <div className="pane">
      <h3>需求</h3>
      <div className="card">
        <div>
          <b>{requirement?.title || '—'}</b>
        </div>
        <div style={{ color: '#555', marginTop: 4, whiteSpace: 'pre-wrap' }}>
          {requirement?.description || '（无描述）'}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', maxHeight: '38vh', marginBottom: 8 }}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
      </div>
      <ChatPanel busy={busy} onSend={onSend} />
    </div>
  )
}
