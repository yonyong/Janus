import { useEffect, useState } from 'react'
import { listAgents, createAgent, deleteAgent, Agent } from '../api'

// coding agent 管理：注册多个 agent（先支持 fake / codebuddy）。
export default function AgentList() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [name, setName] = useState('')
  const [type, setType] = useState('fake')
  const [configText, setConfigText] = useState('{}')
  const [err, setErr] = useState('')

  const load = () => listAgents().then(setAgents).catch((e) => setErr(String(e.message || e)))

  useEffect(() => {
    load()
  }, [])

  const submit = async () => {
    setErr('')
    if (!name.trim()) {
      setErr('请填写 agent 名称')
      return
    }
    let config = {}
    try {
      config = JSON.parse(configText || '{}')
    } catch {
      setErr('config 不是合法 JSON')
      return
    }
    try {
      await createAgent({ name: name.trim(), type, config })
      setName('')
      setConfigText('{}')
      load()
    } catch (e: any) {
      setErr(String(e.message || e))
    }
  }

  return (
    <div className="container">
      <h2>Agent 管理</h2>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <input placeholder="名称，如 codebuddy-1" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 160 }}>
            <option value="fake">fake（联调用）</option>
            <option value="codebuddy">codebuddy</option>
          </select>
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <textarea
            placeholder='config JSON，如 {"cmd":"codebuddy","args":[]}'
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={2}
          />
        </div>
        <button onClick={submit}>添加 Agent</button>
        {err && <div className="fail" style={{ marginTop: 8 }}>{err}</div>}
      </div>

      <div className="card">
        <b>已注册（{agents.length}）</b>
        {agents.length === 0 && <div style={{ color: '#888', marginTop: 6 }}>暂无 Agent</div>}
        {agents.map((a) => (
          <div key={a.id} className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <span>
              #{a.id} <b>{a.name}</b> · <code>{a.type}</code> ·{' '}
              <code>{typeof a.config === 'string' ? a.config : JSON.stringify(a.config)}</code>
            </span>
            <button className="danger" onClick={() => deleteAgent(a.id).then(load)}>删除</button>
          </div>
        ))}
      </div>
    </div>
  )
}
