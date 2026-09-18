import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useToken } from '../auth'
import { listRequirements, sessionMessages, streamEvents, Message, Requirement } from '../api'
import RequirementPane from '../components/RequirementPane'
import CodePane from '../components/CodePane'
import TestPane from '../components/TestPane'

// 四窗格工作台：需求 / 设计 / 编码 / 测试。对话主线在需求窗格，
// 通过 SSE 接收 AgentEvent 并按 type/pane 分流到对应窗格。
export default function Workbench() {
  const { sid } = useParams()
  const sessionId = Number(sid)
  const [params] = useSearchParams()
  const pid = params.get('pid')
  const rid = params.get('rid')
  const token = useToken()

  const [requirement, setRequirement] = useState<Requirement | null>(null)
  const [conv, setConv] = useState<{ role: string; content: string }[]>([])
  const [codeEvents, setCodeEvents] = useState<any[]>([])
  const [testEvents, setTestEvents] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    let active = true
    const populate = async () => {
      try {
        if (pid && rid) {
          const reqs = await listRequirements(token, Number(pid))
          if (active) setRequirement(reqs.find((r) => String(r.id) === String(rid)) || null)
        }
        const msgs: Message[] = await sessionMessages(token, sessionId)
        // 从历史消息按 pane 还原三窗格内容（diff 不落库，仅文本）。
        const c: { role: string; content: string }[] = []
        const code: any[] = []
        const test: any[] = []
        for (const m of msgs) {
          if (m.role === 'user') {
            c.push({ role: 'user', content: m.content })
          } else if (m.pane === 'code') {
            code.push({ text: m.content })
          } else if (m.pane === 'test') {
            test.push({ text: m.content })
          } else {
            c.push({ role: 'agent', content: m.content })
          }
        }
        if (active) {
          setConv(c)
          setCodeEvents(code)
          setTestEvents(test)
        }
      } catch (e: any) {
        if (active) setConv([{ role: 'agent', content: '加载失败：' + String(e.message || e) }])
      }
    }
    populate()
    return () => {
      active = false
      esRef.current?.close()
    }
  }, [sid, pid, rid, token])

  const send = (text: string) => {
    if (busy) return
    setBusy(true)
    setConv((c) => [...c, { role: 'user', content: text }])
    const es = streamEvents(sessionId, text, token)
    esRef.current = es
    es.onmessage = (ev) => {
      let d: any
      try {
        d = JSON.parse(ev.data)
      } catch {
        return
      }
      if (d.type === 'done') {
        es.close()
        setBusy(false)
        return
      }
      if (d.type === 'error') {
        setConv((c) => [...c, { role: 'agent', content: '错误：' + (d.text || '未知错误') }])
        es.close()
        setBusy(false)
        return
      }
      if (d.type === 'edit' || d.pane === 'code') {
        setCodeEvents((e) => [...e, d])
      } else if (d.type === 'test' || d.pane === 'test') {
        setTestEvents((e) => [...e, d])
      } else {
        setConv((c) => [...c, { role: 'agent', content: d.text || '' }])
      }
    }
    es.onerror = () => {
      es.close()
      setBusy(false)
    }
  }

  return (
    <div className="container">
      <h2>工作台 · 会话 {sid}</h2>
      <div className="wb">
        <RequirementPane requirement={requirement} messages={conv} busy={busy} onSend={send} />
        <div className="pane">
          <h3>设计</h3>
          <div style={{ color: '#888' }}>设计窗格（暂留空占位）</div>
        </div>
        <CodePane events={codeEvents} />
        <TestPane events={testEvents} />
      </div>
    </div>
  )
}
