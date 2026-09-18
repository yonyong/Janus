import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useToken } from '../auth'
import {
  listRequirements,
  createRequirement,
  deleteRequirement,
  createSession,
  Requirement,
} from '../api'

// 需求管理：项目下挂多个需求，点开进入四窗格工作台。
export default function RequirementList() {
  const { pid } = useParams()
  const projectId = Number(pid)
  const token = useToken()
  const navigate = useNavigate()
  const [reqs, setReqs] = useState<Requirement[]>([])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = () => {
    listRequirements(token, projectId)
      .then(setReqs)
      .catch((e) => setErr(String(e.message || e)))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])

  const submit = async () => {
    setErr('')
    if (!title.trim()) {
      setErr('请填写需求标题')
      return
    }
    try {
      await createRequirement(token, projectId, {
        title: title.trim(),
        description: description.trim(),
      })
      setTitle('')
      setDescription('')
      load()
    } catch (e: any) {
      setErr(String(e.message || e))
    }
  }

  const enter = async (rid: number) => {
    setErr('')
    setBusyId(rid)
    try {
      const s = await createSession(token, rid)
      navigate(`/workbench/${s.id}?pid=${projectId}&rid=${rid}`)
    } catch (e: any) {
      setErr(String(e.message || e))
      setBusyId(null)
    }
  }

  return (
    <div className="container">
      <h2>需求 · 项目 #{projectId}</h2>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <input placeholder="需求标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <textarea
          placeholder="需求描述（可选）"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
        <div style={{ marginTop: 8 }}>
          <button onClick={submit}>添加需求</button>
        </div>
        {err && <div className="fail" style={{ marginTop: 8 }}>{err}</div>}
      </div>

      {reqs.map((r) => (
        <div className="card" key={r.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b>{r.title}</b>
              {r.description && (
                <div style={{ color: '#555', marginTop: 4, whiteSpace: 'pre-wrap' }}>{r.description}</div>
              )}
            </div>
            <div className="row">
              <button onClick={() => enter(r.id)} disabled={busyId === r.id}>
                {busyId === r.id ? '创建会话中…' : '进入工作台'}
              </button>
              <button className="danger" onClick={() => deleteRequirement(token, r.id).then(load)}>
                删除
              </button>
            </div>
          </div>
        </div>
      ))}

      {reqs.length === 0 && <div className="card" style={{ color: '#888' }}>暂无需求。</div>}
    </div>
  )
}
