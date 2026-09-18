import { useState } from 'react'

// 共享对话输入：描述需求、召唤 coding agent。
export default function ChatPanel({
  busy,
  onSend,
}: {
  busy: boolean
  onSend: (text: string) => void
}) {
  const [v, setV] = useState('')

  const send = () => {
    const t = v.trim()
    if (!t || busy) return
    setV('')
    onSend(t)
  }

  return (
    <div className="row" style={{ marginTop: 8 }}>
      <input
        value={v}
        disabled={busy}
        placeholder={busy ? 'Agent 处理中…' : '描述需求，召唤 coding agent'}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
      />
      <button disabled={busy} onClick={send}>
        发送
      </button>
    </div>
  )
}
