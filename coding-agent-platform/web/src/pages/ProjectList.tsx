import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToken } from '../auth'
import { applyToken } from '../api'
import {
  listProjects,
  createProject,
  deleteProject,
  issueToken,
  Project,
} from '../api'

// 项目管理 + 分享链接签发。业务人员凭链接令牌进入，仅见被授权的项目。
export default function ProjectList() {
  const token = useToken()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [diskPath, setDiskPath] = useState('')
  const [links, setLinks] = useState<Record<number, string>>({})
  const [tokenInput, setTokenInput] = useState('')
  const [err, setErr] = useState('')

  const load = () => {
    if (!token) return setProjects([])
    listProjects(token).then(setProjects).catch((e) => setErr(String(e.message || e)))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const submit = async () => {
    setErr('')
    try {
      await createProject(token, { name: name.trim(), disk_path: diskPath.trim() })
      setName('')
      setDiskPath('')
      load()
    } catch (e: any) {
      setErr(String(e.message || e))
    }
  }

  const genLink = async (pid: number) => {
    try {
      const r = await issueToken(token, pid, { project_ids: [pid] })
      setLinks((p) => ({ ...p, [pid]: r.link }))
    } catch (e: any) {
      setErr(String(e.message || e))
    }
  }

  return (
    <div className="container">
      <h2>项目</h2>

      {!token && (
        <div className="card">
          <div style={{ marginBottom: 8 }}>未检测到访问令牌（?token=）。可粘贴令牌后继续：</div>
          <div className="row">
            <input
              placeholder="粘贴访问令牌"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <button disabled={!tokenInput.trim()} onClick={() => applyToken(tokenInput.trim())}>
              应用
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <input placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="本地磁盘绝对路径，如 D:/dev/myproj"
            value={diskPath}
            onChange={(e) => setDiskPath(e.target.value)}
          />
        </div>
        <button onClick={submit}>添加项目</button>
        {err && <div className="fail" style={{ marginTop: 8 }}>{err}</div>}
      </div>

      {projects.map((p) => (
        <div className="card" key={p.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b>{p.name}</b> · <code>{p.disk_path}</code>
            </div>
            <div className="row">
              <button className="ghost" onClick={() => navigate(`/projects/${p.id}`)}>需求</button>
              <button className="ghost" onClick={() => genLink(p.id)}>生成分享链接</button>
              <button className="danger" onClick={() => deleteProject(token, p.id).then(load)}>删除</button>
            </div>
          </div>
          {links[p.id] && (
            <div style={{ marginTop: 8 }}>
              <span>分享链接：</span>
              <code>{links[p.id]}</code>
              <button
                className="ghost"
                style={{ marginLeft: 8 }}
                onClick={() => navigator.clipboard?.writeText(links[p.id])}>
                复制
              </button>
            </div>
          )}
        </div>
      ))}

      {token && projects.length === 0 && (
        <div className="card" style={{ color: '#888' }}>该令牌下暂无可见项目。</div>
      )}
    </div>
  )
}
