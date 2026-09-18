// 后端 API 封装：所有受保护接口通过 ?token= 透传访问令牌。
// 注意：消息表字段为 content（非 text），会话表含 git_branch 字段。

export interface Agent {
  id: number
  name: string
  type: string
  config: any
}

export interface Project {
  id: number
  name: string
  disk_path: string
}

export interface Requirement {
  id: number
  project_id: number
  title: string
  description: string
}

export interface Session {
  id: number
  requirement_id: number
  agent_id: number
  project_id: number
  git_branch: string | null
}

export interface Message {
  id: number
  session_id: number
  role: string
  pane: string
  content: string
  has_edit: number
  created_at: string
}

export interface AgentEvent {
  type: string // message | edit | test | status | error | done
  pane: string
  text?: string | null
  payload?: any
  diff?: string
}

function buildUrl(path: string, token: string | null, qp?: Record<string, string | number | undefined>): string {
  const u = new URL(path, window.location.origin)
  if (token) u.searchParams.set('token', token)
  if (qp) {
    for (const [k, v] of Object.entries(qp)) {
      if (v !== undefined) u.searchParams.set(k, String(v))
    }
  }
  return u.toString()
}

async function req(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let msg = `${res.status}`
    try {
      const j = await res.json()
      msg = j.detail || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  if (res.status === 204) return null
  return res.json()
}

export function getToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
}

export function applyToken(t: string): void {
  window.location.search = '?token=' + encodeURIComponent(t)
}

// ---------------- Agent 管理 ----------------

export const listAgents = () => req('/api/agents') as Promise<Agent[]>

export const createAgent = (body: { name: string; type: string; config: any }) =>
  req('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Agent>

export const deleteAgent = (id: number) =>
  req(`/api/agents/${id}`, { method: 'DELETE' }) as Promise<any>

// ---------------- 项目管理 ----------------

export const listProjects = (token: string | null) =>
  req(buildUrl('/api/projects', token)) as Promise<Project[]>

export const createProject = (token: string | null, body: { name: string; disk_path: string }) =>
  req(buildUrl('/api/projects', token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Project>

export const deleteProject = (token: string | null, id: number) =>
  req(buildUrl(`/api/projects/${id}`, token), { method: 'DELETE' }) as Promise<any>

export const issueToken = (
  token: string | null,
  pid: number,
  body: { project_ids: number[]; ttl_days?: number | null },
) =>
  req(buildUrl(`/api/projects/${pid}/issue-token`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<{ token: string; link: string }>

// ---------------- 需求管理 ----------------

export const listRequirements = (token: string | null, pid: number) =>
  req(buildUrl(`/api/projects/${pid}/requirements`, token)) as Promise<Requirement[]>

export const createRequirement = (
  token: string | null,
  pid: number,
  body: { title: string; description: string },
) =>
  req(buildUrl(`/api/projects/${pid}/requirements`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Requirement>

export const deleteRequirement = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}`, token), { method: 'DELETE' }) as Promise<any>

// ---------------- 工作台 ----------------

export const createSession = (token: string | null, requirement_id: number) =>
  req(buildUrl('/api/sessions', token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirement_id }),
  }) as Promise<Session>

export const sessionMessages = (token: string | null, sid: number) =>
  req(buildUrl(`/api/sessions/${sid}/messages`, token)) as Promise<Message[]>

/** SSE：触发 agent 处理 message，按事件流推送 AgentEvent。
 *  浏览器 SSE 自动重连复用同一 URL（同一 message），后端以消息内容做幂等回放。 */
export function streamEvents(sid: number, message: string, token: string | null): EventSource {
  const u = new URL(`/api/sessions/${sid}/events`, window.location.origin)
  u.searchParams.set('message', message)
  if (token) u.searchParams.set('token', token)
  return new EventSource(u.toString())
}
