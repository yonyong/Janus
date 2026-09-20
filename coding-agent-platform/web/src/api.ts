// 后端 API 封装：所有受保护接口通过 ?token= 透传访问令牌。
// 注意：消息表字段为 content（非 text），会话表含 git_branch 字段。

export interface Agent {
  id: number
  name: string
  type: string
  config: any
  /** 每日 Token 用量上限：默认 1000 万/天，当日用满即不可用（次日自动重置）；0 表示不限额。 */
  token_limit?: number
  /** 列表顺序即 AI 任务调度优先级（拖拽排序落库的值，从 1 开始）。 */
  sort_order?: number
  /** 今日 Token 用量（调用留痕按天汇总，跨天重置）。 */
  used_tokens?: number
  /** 当日限额未用满即可用；false 表示今日已超限，AI 任务会顺位跳过。 */
  available?: boolean
  /** config.api_key 是否已配置（列表里 key 一律掩码返回，此处仅作标记）。 */
  has_api_key?: boolean
}

export interface AgentProbeEvent {
  type: string
  pane: string
  text?: string | null
  payload?: any
}

export interface AgentTestResult {
  ok: boolean
  agent_id: number
  agent_name: string
  type: string
  message: string
  reply: string | null
  error: string | null
  timed_out: boolean
  rate_limited: boolean
  elapsed_ms: number
  events: AgentProbeEvent[]
  workdir: string | null
}

export interface Project {
  id: number
  name: string
  disk_path: string
}

/** 需求的工作流模式：full 标准四阶段 / lite 轻量（跳过澄清与用例，直接编码）。 */
export type ReqMode = 'full' | 'lite'

export interface Requirement {
  id: number
  project_id: number
  title: string
  description: string
  /** 详细设计文档：Agent 分析原始需求后生成，编码实现阶段的 Agent 按它干活。 */
  design_doc: string
  /** .janus/ 下的需求目录名（取需求名称清洗，创建后固定；需求名称不可改）。 */
  dir_name: string
  /** 工作流模式：full 标准四阶段 / lite 轻量三节点主轴（老数据视为 full）。 */
  mode?: ReqMode
  /** 工作流阶段：clarify 需求澄清 / verify 用例配置 / build 编码实现 / archive 归档验收。 */
  stage?: Stage
  archived_at?: string | null
  verdict?: '' | 'accepted' | 'rejected'
  verdict_note?: string
  /** 创建 / 最近更新时间（本地时间），需求列表卡片展示。 */
  created_at?: string | null
  updated_at?: string | null
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

// ---------------- 凭证存储（统一认证） ----------------
// 两种凭证都落在 localStorage，随请求以 ?token= / ?admin= 透传：
//   · 访问令牌：由管理者签发，只可见被授权项目；分享链接 ?token= 进入时自动落盘。
//   · 管理员口令：等同现状的 CAP_ADMIN_TOKEN，可见全部项目。
// 存储变更统一派发 cap-auth-change，供认证 Provider 重算登录态。

export const ACCESS_KEY = 'cap_access_token'
export const ADMIN_KEY = 'cap_admin_token'

/** 凭证变化的统一事件名；任何写入 localStorage 的入口都必须派发它。 */
export const AUTH_EVENT = 'cap-auth-change'

function notifyAuthChange(): void {
  window.dispatchEvent(new Event(AUTH_EVENT))
}

/** 访问令牌（业务凭证）。 */
export const getStoredToken = (): string | null => localStorage.getItem(ACCESS_KEY)

export const setAccessToken = (t: string | null): void => {
  if (t) localStorage.setItem(ACCESS_KEY, t)
  else localStorage.removeItem(ACCESS_KEY)
  notifyAuthChange()
}

/** 管理员口令（管理凭证），与现状一致。 */
export const getAdminToken = (): string | null => localStorage.getItem(ADMIN_KEY)

export const setAdminToken = (t: string | null): void => {
  if (t) localStorage.setItem(ADMIN_KEY, t)
  else localStorage.removeItem(ADMIN_KEY)
  notifyAuthChange()
}

/** 把分享链接里的 ?token= 落盘，并从地址栏移除，避免长期外泄在 URL / 浏览器历史里。 */
export function adoptUrlToken(t: string | null): void {
  if (t) setAccessToken(t)
  clearUrlToken()
}

/** 仅抹掉地址栏的 ?token=，保留 hash 路由位置，不触发刷新。 */
export function clearUrlToken(): void {
  const u = new URL(window.location.href)
  if (!u.searchParams.has('token')) return
  u.searchParams.delete('token')
  window.history.replaceState(null, '', u.toString())
}

// ---------------- 管理员口令 ----------------
// 口令存 localStorage，随管理类请求以 ?admin= 透传；后端未配置时不产生任何影响。

export interface AdminOverview {
  projects: number
  requirements: number
  sessions: number
  messages: number
  agents: number
  tokens: number
}

export interface AdminProject extends Project {
  requirements: number
  sessions: number
}

export interface AdminToken {
  id: number
  masked: string
  project_ids: number[]
  expires_at: string | null
  expired: boolean
  note: string
  created_at: string | null
  /** 仅 reveal 接口返回：令牌完整原文与可直接访问的链接。 */
  token?: string
  link?: string
}

/** 有效期选项：N 天后过期 / 指定时刻过期 / 永不过期。 */
export type TokenExpiryInput =
  | { ttl_days: number }
  | { expires_at: string }
  | { never: true }

export interface AdminSession {
  id: number
  requirement: string | null
  requirement_id: number | null
  project: string | null
  project_id: number | null
  messages: number
  git_branch: string | null
  created_at: string | null
}

function withAdmin(url: string): string {
  const a = getAdminToken()
  if (!a) return url
  const u = new URL(url, window.location.origin)
  u.searchParams.set('admin', a)
  return u.toString()
}

function adminUrl(path: string): string {
  return withAdmin(new URL(path, window.location.origin).toString())
}

function buildUrl(path: string, token: string | null, qp?: Record<string, string | number | undefined>): string {
  const u = new URL(path, window.location.origin)
  if (token) u.searchParams.set('token', token)
  if (qp) {
    for (const [k, v] of Object.entries(qp)) {
      if (v !== undefined) u.searchParams.set(k, String(v))
    }
  }
  // 管理员解锁后业务接口一并带上口令：后端据此授予全量项目访问权，
  // 管理员无需再单独持有 ?token= 分享令牌。
  return withAdmin(u.toString())
}

// ---------------- 统一错误：既说清原因，也给出下一步 ----------------

const STATUS_LABEL: Record<number, string> = {
  400: '请求参数有误',
  401: '未授权',
  403: '无权限',
  404: '接口不存在',
  405: '请求方式不被允许',
  408: '请求超时',
  409: '资源冲突',
  422: '参数校验失败',
  500: '服务端内部错误',
  502: '上游 Agent 调用失败',
  503: '服务不可用',
  504: '上游 Agent 超时',
}

function isAdminPath(path: string): boolean {
  return path.includes('/api/admin')
}

/** 把状态码 + 接口路径翻译成「用户接下来该做什么」。 */
function hintFor(status: number, path: string): string {
  if (status === 0) {
    return '请确认后端服务已启动（coding-agent-platform 下运行 manage.bat dev，或 uvicorn backend.app:app --port 8000），并检查网络连接。'
  }
  if (status === 408) {
    return '后端可能正在处理耗时任务，稍后重试即可；若持续超时请查看后端日志。'
  }
  if (status === 401) {
    return isAdminPath(path)
      ? '请在管理台输入正确的管理员口令（配置在 coding-agent-platform/.env 的 CAP_ADMIN_TOKEN）；口令变更后需重新解锁。'
      : '请通过项目管理者签发的分享链接进入，或在右上角「未授权」处粘贴有效令牌；令牌被吊销或过期后会失效。'
  }
  if (status === 403) return '当前令牌未被授权访问该项目，请让管理员在管理台重新签发授权范围。'
  if (status === 404) {
    return '接口不存在，通常是前后端版本不一致：请重新执行 npm run build 并重启后端。'
  }
  if (status === 409) return '已存在同名资源，换个名称后重试。'
  if (status === 422) return '请检查表单内容（必填项、格式）后重试。'
  if (status >= 500) {
    return '请查看后端控制台日志里的 traceback；确认后端已加载最新代码并重启后重试。'
  }
  return ''
}

export class ApiError extends Error {
  status: number
  detail: string
  hint: string
  path: string

  constructor(opts: { status: number; detail: string; hint: string; path: string }) {
    const head = opts.status === 0 ? '无法连接后端' : `${STATUS_LABEL[opts.status] || '请求失败'}（${opts.status}）`
    const withDetail = opts.detail ? `${head}：${opts.detail}` : head
    super([withDetail, opts.hint].filter(Boolean).join('。'))
    this.name = 'ApiError'
    this.status = opts.status
    this.detail = opts.detail
    this.hint = opts.hint
    this.path = opts.path
  }
}

/** 供页面把异常拆成「标题 / 原因 / 下一步」三段，用于 Alert 引导用户。 */
export interface ErrorInfo {
  title: string
  hint: string
  detail: string
  status: number
  message: string
}

export function describeError(e: unknown): ErrorInfo {
  if (e instanceof ApiError) {
    return {
      title: e.status === 0 ? '无法连接后端' : `${STATUS_LABEL[e.status] || '请求失败'}（${e.status}）`,
      hint: e.hint,
      detail: e.detail,
      status: e.status,
      message: e.message,
    }
  }
  const msg = String((e as any)?.message || e)
  return { title: '请求失败', hint: '', detail: msg, status: 0, message: msg }
}

/** 读取错误响应体；HTML 错误页与纯文本 "Internal Server Error" 不直接甩给用户。 */
async function readErrorBody(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') || ''
  const text = await res.text().catch(() => '')
  if (ct.includes('json') && text) {
    try {
      const j = JSON.parse(text)
      const d = j && (j.detail || j.message)
      if (d) return String(d)
    } catch {
      /* 落到下面的文本兜底 */
    }
  }
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (/^internal server error$/i.test(trimmed)) return ''
  if (trimmed.startsWith('<')) return ''
  return trimmed.slice(0, 160)
}

interface ReqOptions extends RequestInit {
  /** 超时毫秒，默认 30s。 */
  timeoutMs?: number
  /** GET 请求在 5xx / 网络错误时是否自动重试一次，默认 true。 */
  retryOnce?: boolean
}

async function requestOnce(path: string, init: ReqOptions): Promise<any> {
  const { timeoutMs = 30000, retryOnce: _ignore, ...rest } = init
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(path, { ...rest, signal: ctrl.signal })
  } catch (e: any) {
    const aborted = e?.name === 'AbortError'
    throw new ApiError({
      status: aborted ? 408 : 0,
      detail: aborted ? `超过 ${Math.round(timeoutMs / 1000)}s 未响应` : `网络错误（${e?.message || e}）`,
      hint: hintFor(aborted ? 408 : 0, path),
      path,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const detail = await readErrorBody(res)
    const status = res.status
    throw new ApiError({ status, detail, hint: hintFor(status, path), path })
  }
  if (res.status === 204) return null
  try {
    return await res.json()
  } catch {
    throw new ApiError({
      status: 500,
      detail: '响应不是合法 JSON',
      hint: hintFor(500, path),
      path,
    })
  }
}

async function req(path: string, init?: ReqOptions): Promise<any> {
  const { timeoutMs = 30000, retryOnce = true, ...rest } = init || {}
  const method = (rest.method || 'GET').toUpperCase()
  const attemptable = retryOnce && method === 'GET'
  const maxAttempts = attemptable ? 2 : 1
  let last: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await requestOnce(path, { ...rest, timeoutMs })
    } catch (e) {
      last = e
      const retriable = e instanceof ApiError && (e.status === 0 || e.status === 408 || e.status >= 500)
      if (!retriable || attempt === maxAttempts - 1) throw e
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  throw last
}

/**
 * 当前访问令牌。以落盘凭证为准；启动阶段分享链接的 ?token= 还没落盘时回退读地址栏，
 * 保证认证 Provider 完成引导前的任何请求也带得上凭证。
 */
export function getToken(): string | null {
  return getStoredToken() || readUrlToken()
}

/** 从地址栏读取一次性分享令牌（仅供认证 Provider 启动引导使用）。 */
export function readUrlToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
}

// ---------------- 令牌校验 ----------------

export interface TokenVerifyResult {
  valid: boolean
  project_count: number
  expires_at: string | null
}

/** 先验证令牌再落到本地：不存在 / 已吊销 / 已过期都会抛 ApiError(401)。 */
export const verifyToken = (t: string) =>
  req(buildUrl('/api/token/verify', t), { retryOnce: false }) as Promise<TokenVerifyResult>

/**
 * 校验管理员口令。输入错误抛 401；后端未启用口令（开放模式）抛 400——
 * 这两种都要与「后端连不上」区分开，弹框据此给出不同引导。
 * 注意：这里用的是**待校验的候选口令**，不能走 adminUrl()（那读的是本地已存口令）。
 */
export const verifyAdmin = (pwd: string) => {
  const u = new URL('/api/admin/verify', window.location.origin)
  u.searchParams.set('admin', pwd)
  return req(u.toString(), { retryOnce: false }) as Promise<{
    ok: boolean
    admin_enabled: boolean
  }>
}

// ---------------- Agent 管理 ----------------

export const listAgents = () => req('/api/agents') as Promise<Agent[]>

export const createAgent = (body: { name: string; type: string; config: any; token_limit?: number }) =>
  req(withAdmin('/api/agents'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Agent>

/** 编辑 Agent 配置：只提交要改的字段，未提交的保持原值（token_limit 0=不限额）。需管理员口令。 */
export const updateAgent = (id: number, body: { name?: string; type?: string; config?: any; token_limit?: number }) =>
  req(withAdmin(`/api/agents/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Agent>

/** 拖拽排序：ids 按目标顺序包含全部 Agent 的 id。需管理员口令。 */
export const reorderAgents = (ids: number[]) =>
  req(withAdmin('/api/agents/reorder'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }) as Promise<Agent[]>

/** 一键连通性测试：向该 agent 发一条探针消息（默认「你好」），返回是否可用。 */
export const testAgent = (id: number, body?: { message?: string; timeout?: number }) =>
  req(withAdmin(`/api/agents/${id}/test`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    // 真实 Agent 冷启动较慢，给足 3 分钟
    timeoutMs: 180000,
  }) as Promise<AgentTestResult>

export const deleteAgent = (id: number) =>
  req(withAdmin(`/api/agents/${id}`), { method: 'DELETE' }) as Promise<any>

// ---------------- 项目管理 ----------------

export const listProjects = (token: string | null) =>
  req(buildUrl('/api/projects', token)) as Promise<Project[]>

export const createProject = (token: string | null, body: { name: string; disk_path: string }) =>
  req(withAdmin(buildUrl('/api/projects', token)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Project>

export const deleteProject = (token: string | null, id: number) =>
  req(withAdmin(buildUrl(`/api/projects/${id}`, token)), { method: 'DELETE' }) as Promise<any>

/** 编辑项目信息：只提交要改的字段。磁盘路径改动后立即生效。需管理员口令。 */
export const updateProject = (
  token: string | null,
  id: number,
  body: { name?: string; disk_path?: string },
) =>
  req(withAdmin(buildUrl(`/api/projects/${id}`, token)), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Project>

export const issueToken = (token: string | null, pid: number, body: IssueTokenBody) =>
  req(withAdmin(buildUrl(`/api/projects/${pid}/issue-token`, token)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<{ token: string; link: string; expires_at: string | null; note: string }>

// ---------------- 需求管理 ----------------

export const listRequirements = (token: string | null, pid: number) =>
  req(buildUrl(`/api/projects/${pid}/requirements`, token)) as Promise<Requirement[]>

export const createRequirement = (
  token: string | null,
  pid: number,
  body: { title: string; description: string; mode?: ReqMode },
) =>
  req(buildUrl(`/api/projects/${pid}/requirements`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Requirement>

export const deleteRequirement = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}`, token), { method: 'DELETE' }) as Promise<any>

// ---------------- 工作流：需求澄清 → 用例配置 → 编码实现 → 归档验收 ----------------

export type Stage = 'clarify' | 'build' | 'verify' | 'archive'
export type CaseStatus = 'pending' | 'passed' | 'failed' | 'skipped'
export type Verdict = 'accepted' | 'rejected'

export const STAGE_LABELS: Record<Stage, string> = {
  clarify: '需求澄清',
  verify: '用例配置',
  build: '编码实现',
  archive: '归档验收',
}

/** 工作流节点顺序：用例配置提前到编码实现之前 —— 先定「怎么算做完」，再让 Agent 动手。 */
export const STAGE_ORDER: Stage[] = ['clarify', 'verify', 'build', 'archive']

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  pending: '待验证',
  passed: '通过',
  failed: '失败',
  skipped: '跳过',
}

/** 需求文档版本的来源。 */
export type DocSource = 'create' | 'manual' | 'ai' | 'revert'

export const DOC_SOURCE_LABELS: Record<DocSource, string> = {
  create: '创建',
  manual: '手动保存',
  ai: 'AI 润色',
  revert: '版本回退',
}

export interface TestCase {
  id: number
  requirement_id: number
  title: string
  steps: string
  expected: string
  status: CaseStatus
  note: string
  source: string
  /** 人工验收项：不进总验收脚本，由人在页面上勾选。 */
  is_manual?: boolean | number
  created_at?: string | null
  updated_at?: string | null
}

export interface CaseStats {
  total: number
  passed: number
  failed: number
  pending: number
  skipped: number
  done: number
  /** 标了「人工」的用例数 / 其中尚未勾选结果的数（归档页「人工待核」）。 */
  manual?: number
  manual_pending?: number
}

/** 总验收脚本状态（一需求一份 accept.*）。 */
export interface AcceptScriptStatus {
  exists: boolean
  path: string
  name: string | null
  mtime: string | null
  stale: boolean
  lang: string | null
  coverage: {
    known: boolean
    covered_ids: number[]
    uncovered_ids: number[]
    uncovered: number
  }
}

export interface AcceptRunResult {
  ran: boolean
  reason?: string
  detail?: string
  entry?: string
  exit_code?: number
  output?: string
  truncated?: boolean
  timeout?: number
  lang?: string
  sync?: { found: boolean; rows: number; updated: number; stats: Record<string, number> } | null
}

/** 通用脚本参数定义（来自 YAML frontmatter）。 */
export interface ScriptParamDef {
  name: string
  label: string
  type: 'string' | 'number' | 'boolean'
  default?: string | number | boolean | null
  required?: boolean
}

/** 列表项 / 详情共用的脚本元信息。 */
export interface ScriptItem {
  name: string
  display_name: string
  desc: string
  params: ScriptParamDef[]
  lang: string
  mtime?: string
  path?: string
  last_params?: Record<string, string>
  run_count?: number
  content?: string
  body?: string
}

export interface ScriptRunRecord {
  id: string
  started_at: string
  exit_code: number
  params: Record<string, string>
  output: string
  duration_ms: number
  truncated?: boolean
}

export interface ScriptRunResult {
  ran: boolean
  reason?: string
  detail?: string
  entry?: string
  exit_code?: number
  output?: string
  truncated?: boolean
  timeout?: number
  lang?: string
  duration_ms?: number
  run?: ScriptRunRecord
  last_params?: Record<string, string>
}

export interface ChangedFile {
  status: string
  path: string
}

export interface WorkflowState {
  requirement: Requirement
  stage: Stage
  cases: CaseStats
  sessions: { id: number; created_at: string | null; git_branch: string | null; agent: string | null; messages: number }[]
  /** git 视角的当前未提交改动（非 git 项目 available=false）。 */
  changes: { available: boolean; files: ChangedFile[]; truncated: boolean }
  /** 平台自己记录的改动累计（不依赖 git），归档与编码实现阶段都以它为准。 */
  change_sets: { sets: number; files: number; added: number; modified: number; removed: number }
  /** 需求文档历史版本数。 */
  versions: number
  archived_at: string | null
  verdict: '' | Verdict
  verdict_note: string
}

export interface AiGenResult {
  created: number
  cases: TestCase[]
  raw: string
  warning: string
  elapsed_ms: number
  agent: string | null
}

export interface AiPolishResult {
  content: string
  raw: string
  /** 非空表示模型没给出可用正文（此时 content 为空），前端应提示并展示原文。 */
  warning: string
  elapsed_ms: number
  agent: string | null
}

/** 需求文档 / 阶段 / 工作流模式的部分更新。source 用于标注这版文档从哪来（手动保存 / AI 润色）。 */
export const updateRequirement = (
  token: string | null,
  rid: number,
  body: { title?: string; description?: string; design_doc?: string; stage?: Stage; source?: DocSource; mode?: ReqMode },
) =>
  req(buildUrl(`/api/requirements/${rid}`, token), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Requirement>

export const setRequirementStage = (token: string | null, rid: number, stage: Stage) =>
  req(buildUrl(`/api/requirements/${rid}/stage`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
  }) as Promise<Requirement>

export const requirementWorkflow = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/workflow`, token)) as Promise<WorkflowState>

export const archiveRequirement = (
  token: string | null,
  rid: number,
  verdict: Verdict,
  note: string,
) =>
  req(buildUrl(`/api/requirements/${rid}/archive`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verdict, note }),
  }) as Promise<Requirement>

// ---------------- 功能验证：用例 ----------------

export const listCases = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/cases`, token)) as Promise<TestCase[]>

export interface CaseInput {
  title: string
  steps?: string
  expected?: string
  status?: CaseStatus
  note?: string
  is_manual?: boolean
}

/** 总验收脚本状态：是否存在、路径、是否过期、覆盖度。 */
export const acceptScriptStatus = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/accept-script`, token)) as Promise<AcceptScriptStatus>

/** 执行总验收脚本 → 解析测试报告回写用例状态。脚本不存在时 ran=false。 */
export const runAcceptScript = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/accept-script/run`, token), {
    method: 'POST',
  }) as Promise<AcceptRunResult>

/** 通用脚本列表（.janus/{dir}/script/）。 */
export const listScripts = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/scripts`, token)) as Promise<ScriptItem[]>

export const getScript = (token: string | null, rid: number, name: string) =>
  req(buildUrl(`/api/requirements/${rid}/scripts/${encodeURIComponent(name)}`, token)) as Promise<ScriptItem>

export const saveScript = (token: string | null, rid: number, name: string, content: string) =>
  req(buildUrl(`/api/requirements/${rid}/scripts/${encodeURIComponent(name)}`, token), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }) as Promise<ScriptItem>

export const deleteScript = (token: string | null, rid: number, name: string) =>
  req(buildUrl(`/api/requirements/${rid}/scripts/${encodeURIComponent(name)}`, token), {
    method: 'DELETE',
  }) as Promise<{ ok: boolean }>

export const runScript = (
  token: string | null,
  rid: number,
  name: string,
  params: Record<string, string | number | boolean> = {},
) =>
  req(buildUrl(`/api/requirements/${rid}/scripts/${encodeURIComponent(name)}/run`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params }),
  }) as Promise<ScriptRunResult>

export const listScriptRuns = (token: string | null, rid: number, name: string) =>
  req(buildUrl(`/api/requirements/${rid}/scripts/${encodeURIComponent(name)}/runs`, token)) as Promise<ScriptRunRecord[]>

export const createCase = (token: string | null, rid: number, body: CaseInput) =>
  req(buildUrl(`/api/requirements/${rid}/cases`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<TestCase>

/** 从工作区导入 AI 用例草稿（对话生成 → Agent 写 .janus/{dir}/usecase/cases-draft.md → 导入落库）。 */
export const importCasesFromWorkspace = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/cases/import`, token), {
    method: 'POST',
  }) as Promise<{ created: number; cases: TestCase[]; skipped: number; total: number }>

export const updateCase = (
  token: string | null,
  cid: number,
  body: Partial<CaseInput>,
) =>
  req(buildUrl(`/api/cases/${cid}`, token), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<TestCase>

/** 批量删除用例（先整体校验权限与存在性，再一次性删除）。 */
export const batchDeleteCases = (token: string | null, ids: number[]) =>
  req(buildUrl(`/api/cases/batch-delete`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }) as Promise<{ deleted: number }>

export const deleteCase = (token: string | null, cid: number) =>
  req(buildUrl(`/api/cases/${cid}`, token), { method: 'DELETE' }) as Promise<any>

/**
 * 从工作区测试报告（.janus/{dir}/arch/test-result.md 表格）同步用例状态。
 * 进入归档验收时调用：报告是 Agent 写的文件，页面统计读的是库里的状态，
 * 不同步的话 Agent 说 30/30 全过、页面仍显示 0/30。
 */
export const syncTestResults = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/test-result/sync`, token), {
    method: 'POST',
  }) as Promise<{ found: boolean; rows: number; updated: number; stats: Record<string, number> }>

/** AI 依据需求文档生成用例（后端解析 JSON 并落库；耗时较长，给足 4 分钟）。 */
export const generateCases = (
  token: string | null,
  rid: number,
  body: { session_id?: number; count?: number; doc?: string; title?: string } = {},
) =>
  req(buildUrl(`/api/requirements/${rid}/cases/generate`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 240000,
  }) as Promise<AiGenResult>

/** AI 润色需求文档：返回正文，由用户确认后再保存（不会自动改库）。 */
export const polishRequirement = (
  token: string | null,
  rid: number,
  body: { session_id?: number; doc?: string; title?: string } = {},
) =>
  req(buildUrl(`/api/requirements/${rid}/polish`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 240000,
  }) as Promise<AiPolishResult>

/** AI 依据原始需求生成详细设计文档：返回正文，由用户采纳后保存（不会自动改库）。 */
export const generateDesignDoc = (
  token: string | null,
  rid: number,
  body: { session_id?: number; doc?: string; title?: string } = {},
) =>
  req(buildUrl(`/api/requirements/${rid}/design`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 240000,
  }) as Promise<AiPolishResult>

// ---------------- 工作流附件（需求附件 / 用例附件） ----------------

export interface Attachment {
  id: number
  requirement_id: number
  /** null = 需求澄清阶段的附件；非空 = 对应用例的附件。 */
  case_id: number | null
  filename: string
  /** 项目内相对路径（.janus/...），编码 Agent 按它读取。 */
  path: string
  size: number
  created_at?: string | null
}

/** 上传需求附件（多文件）；文件实体落项目工作区 .janus/attachments/ 下。 */
export async function uploadRequirementAttachments(
  token: string | null,
  rid: number,
  files: File[],
): Promise<Attachment[]> {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  return req(buildUrl(`/api/requirements/${rid}/attachments`, token), {
    method: 'POST',
    body: fd,
    timeoutMs: 120000,
  }) as Promise<Attachment[]>
}

/** 给单条用例上传附件；文件落 .janus/cases/ 下并进入用例清单导出。 */
export async function uploadCaseAttachments(
  token: string | null,
  cid: number,
  files: File[],
): Promise<Attachment[]> {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  return req(buildUrl(`/api/cases/${cid}/attachments`, token), {
    method: 'POST',
    body: fd,
    timeoutMs: 120000,
  }) as Promise<Attachment[]>
}

export const listAttachments = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/attachments`, token)) as Promise<Attachment[]>

/** 对话输入框粘贴/选择的文件：存 .janus/{dir}/chat/attach/，返回项目内相对路径。
 *  路径随消息文本一并发出，Agent 可直接读取，历史消息里也能点开预览。 */
export async function uploadSessionAttachments(
  token: string | null,
  sid: number,
  files: File[],
): Promise<{ path: string; filename: string; size: number }[]> {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  return req(buildUrl(`/api/sessions/${sid}/attachments`, token), {
    method: 'POST',
    body: fd,
    timeoutMs: 120000,
  }) as Promise<{ path: string; filename: string; size: number }[]>
}

export const deleteAttachment = (token: string | null, aid: number) =>
  req(buildUrl(`/api/attachments/${aid}`, token), { method: 'DELETE' }) as Promise<any>

// ---------------- 需求澄清：文档历史版本 ----------------

/** 版本列表项：不带正文，只给字数与开头预览，避免一次拉回全部历史全文。 */
export interface RequirementVersion {
  id: number
  title: string
  source: DocSource
  note: string
  created_at: string | null
  chars: number
  preview: string
  /** 内容与当前需求一致且是最新一版 —— 即「当前生效版本」。 */
  current: boolean
}

export interface RequirementVersionDetail {
  id: number
  requirement_id: number
  title: string
  description: string
  source: DocSource
  note: string
  created_at: string | null
}

export const listRequirementVersions = (token: string | null, rid: number) =>
  req(buildUrl(`/api/requirements/${rid}/versions`, token)) as Promise<RequirementVersion[]>

export const getRequirementVersion = (token: string | null, rid: number, vid: number) =>
  req(buildUrl(`/api/requirements/${rid}/versions/${vid}`, token)) as Promise<RequirementVersionDetail>

/** 回退到指定版本：旧内容作为一次新的修改写回，回退本身也进历史。 */
export const restoreRequirementVersion = (token: string | null, rid: number, vid: number) =>
  req(buildUrl(`/api/requirements/${rid}/versions/${vid}/restore`, token), {
    method: 'POST',
  }) as Promise<Requirement>

// ---------------- 编码实现：工作区改动记录与回退 ----------------

export type ChangeSource = 'agent' | 'revert'

export const CHANGE_SOURCE_LABELS: Record<ChangeSource, string> = {
  agent: 'Agent 改动',
  revert: '回退',
}

export type FileChangeStatus = 'added' | 'modified' | 'removed'

export const FILE_STATUS_LABELS: Record<FileChangeStatus, string> = {
  added: '新增',
  modified: '修改',
  removed: '删除',
}

export interface ChangeSetFileBrief {
  path: string
  status: FileChangeStatus
}

export interface ChangeSet {
  id: number
  project_id: number
  session_id: number | null
  requirement_id: number | null
  source: ChangeSource
  note: string
  created_at: string | null
  added: number
  modified: number
  removed: number
  truncated: boolean
  file_count: number
  preview: ChangeSetFileBrief[]
}

export interface ChangeSetFile extends ChangeSetFileBrief {
  id: number
  binary: boolean
  /** 二进制 / 超大文件没存内容，回退不了，前端据此禁用按钮。 */
  revertible: boolean
  before_chars: number
  after_chars: number
  diff: string
}

export interface ChangeSetDetail extends ChangeSet {
  files: ChangeSetFile[]
}

export interface RevertFileResult {
  path: string
  ok: boolean
  action?: 'restored' | 'removed' | 'absent'
  error?: string
}

export interface RevertResult {
  /** 全部成功才是 true；有文件被跳过即为 false。 */
  ok: boolean
  reverted: number
  skipped: number
  results: RevertFileResult[]
  /** 回退动作本身记录的改动集；一个文件都没成功时为 null。 */
  change_set: ChangeSet | null
}

export const listChangeSets = (
  token: string | null,
  pid: number,
  params: { session_id?: number; limit?: number } = {},
) => {
  const q = new URLSearchParams()
  if (params.session_id != null) q.set('session_id', String(params.session_id))
  if (params.limit != null) q.set('limit', String(params.limit))
  const qs = q.toString()
  return req(buildUrl(`/api/projects/${pid}/changesets${qs ? `?${qs}` : ''}`, token)) as Promise<ChangeSet[]>
}

export const changeSetDetail = (token: string | null, csid: number) =>
  req(buildUrl(`/api/changesets/${csid}`, token)) as Promise<ChangeSetDetail>

export const revertChangeSet = (token: string | null, csid: number) =>
  req(buildUrl(`/api/changesets/${csid}/revert`, token), { method: 'POST' }) as Promise<RevertResult>

export const revertChangeFile = (token: string | null, csid: number, fid: number) =>
  req(buildUrl(`/api/changesets/${csid}/files/${fid}/revert`, token), {
    method: 'POST',
  }) as Promise<RevertResult>

// ---------------- 工作台 ----------------

export interface SessionDetail extends Session {
  project: string | null
  disk_path: string | null
  requirement: Requirement | null
  agent: { id: number; name: string; type: string } | null
}

/** 会话详情：工作台据此拿到项目磁盘路径，因此不再依赖 URL 上的 ?pid=。 */
export const sessionDetail = (token: string | null, sid: number) =>
  req(buildUrl(`/api/sessions/${sid}`, token)) as Promise<SessionDetail>

export const createSession = (
  token: string | null,
  requirement_id: number,
  agent_id?: number,
) =>
  req(buildUrl('/api/sessions', token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requirement_id,
      ...(agent_id != null ? { agent_id } : {}),
    }),
  }) as Promise<Session>

/** 切换会话当前使用的 coding agent（对话面板多 Agent 时可选）。 */
export const setSessionAgent = (token: string | null, sid: number, agent_id: number) =>
  req(buildUrl(`/api/sessions/${sid}/agent`, token), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id }),
  }) as Promise<{
    id: number
    agent_id: number
    agent: { id: number; name: string; type: string } | null
  }>

export const sessionMessages = (token: string | null, sid: number) =>
  req(buildUrl(`/api/sessions/${sid}/messages`, token)) as Promise<Message[]>

/** 会话当前是否有仍在后台进行的 agent 运行；有则返回触发它的原始消息。
 *  页面刷新后 SSE 连接已断，靠它重新订阅续传，避免流式输出凭空消失。 */
export const sessionActiveRun = (token: string | null, sid: number) =>
  req(buildUrl(`/api/sessions/${sid}/active-run`, token)) as Promise<{
    active: boolean
    run_id: string | null
    message: string | null
  }>

/** 真中止会话进行中的 agent 运行：后端取消 run 任务并杀掉 CLI 子进程树（不是只断 SSE）。 */
export const abortSessionRun = (token: string | null, sid: number) =>
  req(buildUrl(`/api/sessions/${sid}/abort`, token), {
    method: 'POST',
    retryOnce: false,
  }) as Promise<{ aborted: boolean; run_id: string | null; message: string | null }>

/** SSE：触发 agent 处理 message，按事件流推送 AgentEvent。
 *  浏览器 SSE 自动重连复用同一 URL（同一 message），后端以消息内容做幂等回放。 */
export function streamEvents(sid: number, message: string, token: string | null): EventSource {
  const u = new URL(`/api/sessions/${sid}/events`, window.location.origin)
  u.searchParams.set('message', message)
  if (token) u.searchParams.set('token', token)
  const a = getAdminToken()
  if (a) u.searchParams.set('admin', a)
  return new EventSource(u.toString())
}

// ---------------- 工作台文件面板（项目工作区文件 CRUD） ----------------

export interface FileEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  size: number | null
  mtime: string | null
  ext: string
}

export interface DirListing {
  path: string
  parent: string
  root: string
  entries: FileEntry[]
  truncated: boolean
  limit: number
}

export interface FileSearchResult {
  query: string
  entries: FileEntry[]
  truncated: boolean
  limit: number
}

export interface FileContent {
  path: string
  size: number
  truncated: boolean
  binary: boolean
  content: string
  message: string
}

/** 列出一个目录的直接子项；path 为空表示项目根目录。 */
export const listFiles = (token: string | null, pid: number, path: string) =>
  req(buildUrl(`/api/projects/${pid}/files`, token, { path })) as Promise<DirListing>

/** 全工作区文件名模糊检索（子串 + 子序列）。 */
export const searchFiles = (token: string | null, pid: number, q: string, limit = 200) =>
  req(buildUrl(`/api/projects/${pid}/files/search`, token, { q, limit })) as Promise<FileSearchResult>

export const readFile = (token: string | null, pid: number, path: string) =>
  req(buildUrl(`/api/projects/${pid}/file`, token, { path })) as Promise<FileContent>

/** 原始字节流 URL（鉴权走 query token）：PDF/图片直接喂 iframe/img，
 *  xlsx/docx 由前端库按二进制解析；download=true 时后端加附件下载头。 */
export const fileRawUrl = (token: string | null, pid: number, path: string, download = false) =>
  buildUrl(`/api/projects/${pid}/file/raw`, token, {
    path,
    download: download ? 'true' : undefined,
  })

/** 路径内嵌版 raw URL：HTML 预览的 iframe 用它，页面里的相对引用
 *  （script src="assets/x.js" 等）会解析到同一路由下而自然可加载。 */
export const fileRawPathUrl = (token: string | null, pid: number, path: string) =>
  buildUrl(`/api/projects/${pid}/raw/${path}`, token)

/** 保存文件内容；文件不存在则新建（上级目录必须已存在）。 */
export const saveFile = (token: string | null, pid: number, path: string, content: string) =>
  req(buildUrl(`/api/projects/${pid}/file`, token), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  }) as Promise<{ ok: boolean; path: string; created: boolean; size: number }>

export const createEntry = (token: string | null, pid: number, path: string, type: 'file' | 'dir') =>
  req(buildUrl(`/api/projects/${pid}/files`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, type }),
  }) as Promise<FileEntry>

export const renameEntry = (token: string | null, pid: number, path: string, newName: string) =>
  req(buildUrl(`/api/projects/${pid}/files/rename`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, new_name: newName }),
  }) as Promise<FileEntry>

/** 删除文件或目录；recursive 仅在删除非空目录时置真（会有二次确认）。 */
export const deleteEntry = (token: string | null, pid: number, path: string, recursive = false) =>
  req(buildUrl(`/api/projects/${pid}/files`, token, { path, recursive: recursive ? 'true' : 'false' }), {
    method: 'DELETE',
  }) as Promise<{ ok: boolean; path: string }>

// ---------------- 实时日志（项目运行诊断流） ----------------
// 数据来自后端进程内日志总线：观测「此刻这个项目正在发生什么」（agent 原始输出、会话
// 生命周期、文件改动、操作留痕）。它不落库 —— 要查历史/追责请看管理台的审计页。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  seq: number
  ts: string
  project_id: number | null
  level: LogLevel
  source: string
  text: string
  meta?: Record<string, any> | null
}

export interface LogPage {
  records: LogRecord[]
  last_seq: number
  /** 请求位置已早于缓冲最老一条 —— 中间有记录被滚出。 */
  dropped: boolean
  /** 命中条数超过 limit，只返回了最新的一部分。 */
  truncated: boolean
  buffered: number
  capacity: number
}

/** 级别顺序由轻到重，界面按此顺序渲染筛选项与配色。 */
export const LOG_LEVELS: { key: LogLevel; label: string; color: string }[] = [
  { key: 'debug', label: '调试', color: '#8f959e' },
  { key: 'info', label: '信息', color: '#3370ff' },
  { key: 'warn', label: '警告', color: '#ff8800' },
  { key: 'error', label: '错误', color: '#f54a45' },
]

/** 来源取值与后端 logbus.SOURCES 对齐；未列出的来源会归入「其他」。 */
export const LOG_SOURCES: { key: string; label: string }[] = [
  { key: 'session', label: '会话' },
  { key: 'agent', label: 'Agent 输出' },
  { key: 'probe', label: '一键测试' },
  { key: 'files', label: '文件改动' },
  { key: 'audit', label: '操作留痕' },
  { key: 'system', label: '平台' },
]

export const logSourceLabel = (key: string): string =>
  LOG_SOURCES.find((s) => s.key === key)?.label || key || '其他'

export interface LogQuery {
  after_seq?: number
  limit?: number
  level?: string
  source?: string
  include_global?: boolean
}

export const listProjectLogs = (token: string | null, pid: number, params: LogQuery = {}) =>
  req(
    buildUrl(`/api/projects/${pid}/logs`, token, {
      after_seq: params.after_seq,
      limit: params.limit,
      level: params.level,
      source: params.source,
      include_global: params.include_global ? 1 : undefined,
    }),
  ) as Promise<LogPage>

/** SSE：订阅某个项目的实时日志。
 *  level/source 为空表示全量推送（界面上的筛选默认在本地做，避免切筛选就断流重连）。 */
export function streamProjectLogs(
  pid: number,
  token: string | null,
  params: LogQuery = {},
): EventSource {
  const u = new URL(`/api/projects/${pid}/logs/stream`, window.location.origin)
  u.searchParams.set('after_seq', String(params.after_seq ?? 0))
  if (params.level) u.searchParams.set('level', params.level)
  if (params.source) u.searchParams.set('source', params.source)
  if (params.include_global) u.searchParams.set('include_global', 'true')
  if (token) u.searchParams.set('token', token)
  const a = getAdminToken()
  if (a) u.searchParams.set('admin', a)
  return new EventSource(u.toString())
}

// ---------------- 管理台（需管理员口令） ----------------

/** 后端是否启用了管理员口令。 */
export const adminState = () =>
  req('/api/admin/state') as Promise<{ admin_enabled: boolean }>

export const adminOverview = () =>
  req(adminUrl('/api/admin/overview')) as Promise<AdminOverview>

export const adminListProjects = () =>
  req(adminUrl('/api/admin/projects')) as Promise<AdminProject[]>

export const adminCreateProject = (body: { name: string; disk_path: string }) =>
  req(adminUrl('/api/admin/projects'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Project>

export const adminDeleteProject = (pid: number) =>
  req(adminUrl(`/api/admin/projects/${pid}`), { method: 'DELETE' }) as Promise<any>

/** 管理台编辑项目信息：只提交要改的字段，未提交的保持原值。 */
export const adminUpdateProject = (pid: number, body: { name?: string; disk_path?: string }) =>
  req(adminUrl(`/api/admin/projects/${pid}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<Project>

export const adminListTokens = () =>
  req(adminUrl('/api/admin/tokens')) as Promise<AdminToken[]>

export interface IssueTokenBody {
  project_ids: number[]
  note?: string
  ttl_days?: number | null
  expires_at?: string | null
}

export const adminIssueToken = (body: IssueTokenBody) =>
  req(adminUrl('/api/admin/tokens'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<{
    token: string
    link: string
    project_ids: number[]
    expires_at: string | null
    note: string
    id: number | null
  }>

export const adminRevokeToken = (id: number) =>
  req(adminUrl(`/api/admin/tokens/${id}`), { method: 'DELETE' }) as Promise<any>

/** 查看已签发令牌的完整原文：签发后随时可读，而不只在签发成功的那一次可见。 */
export const adminRevealToken = (id: number) =>
  req(adminUrl(`/api/admin/tokens/${id}/reveal`)) as Promise<AdminToken>

/** 更新备注和/或有效期；never_expires 为真表示改为永不过期。 */
export const adminUpdateToken = (
  id: number,
  body: {
    note?: string
    expires_at?: string | null
    ttl_days?: number | null
    never_expires?: boolean
  },
) =>
  req(adminUrl(`/api/admin/tokens/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<AdminToken>

export const adminListAgents = () =>
  req(adminUrl('/api/admin/agents')) as Promise<Agent[]>

export const adminListSessions = () =>
  req(adminUrl('/api/admin/sessions')) as Promise<AdminSession[]>

// ---------------- 审计：操作日志 ----------------

/** 操作者身份：管理员口令 / 访问令牌 / 匿名（未带任何有效凭证）。 */
export type ActorType = 'admin' | 'token' | 'anonymous'

export const ACTOR_TYPE_LABELS: Record<ActorType, string> = {
  admin: '管理员',
  token: '访问令牌',
  anonymous: '匿名',
}

export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  project: '项目',
  token: '令牌',
  agent: 'Agent',
  requirement: '需求',
  file: '文件',
  changeset: '改动回退',
  session: '会话',
  other: '其他',
}

/** 动作 → 中文名。接口新增动作时会回落到原始 action 串，不会显示成空白。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'project.create': '新建项目',
  'project.update': '编辑项目',
  'project.delete': '删除项目',
  'token.issue': '签发令牌',
  'token.update': '修改令牌',
  'token.revoke': '吊销令牌',
  'token.reveal': '查看令牌原文',
  'agent.create': '新增 Agent',
  'agent.update': '编辑 Agent',
  'agent.delete': '删除 Agent',
  'agent.test': '一键测试',
  'agent.reorder': 'Agent 排序',
  'requirement.create': '新建需求',
  'requirement.update': '修改需求',
  'requirement.delete': '删除需求',
  'requirement.stage': '切换阶段',
  'requirement.archive': '归档验收',
  'requirement.restore': '回退文档版本',
  'file.write': '保存文件',
  'file.create': '新建文件',
  'file.rename': '重命名',
  'file.delete': '删除文件',
  'changeset.revert': '回退整条改动',
  'changeset.revert_file': '回退单个文件',
  'session.create': '创建会话',
  'session.abort': '中止运行',
}

export const auditActionLabel = (action: string) => AUDIT_ACTION_LABELS[action] || action
export const auditCategoryLabel = (c: string) => AUDIT_CATEGORY_LABELS[c] || c

export interface AuditLog {
  id: number
  actor_type: ActorType
  /** 令牌的脱敏串；管理员固定为 admin。日志里不会有令牌原文。 */
  actor: string
  token_id: number | null
  ip: string
  category: string
  action: string
  status: 'success' | 'failure'
  target_type: string
  target_id: number | null
  target_name: string
  project_id: number | null
  project_name: string
  /** JSON 串，记录本次改动的要点。 */
  detail: string
  error: string
  created_at: string | null
}

export interface AuditStats {
  total: number
  success: number
  failure: number
  today: number
  projects: number
}

export interface AuditFacet {
  value: string
  count: number
}

export interface AuditLogPage {
  total: number
  items: AuditLog[]
  stats: AuditStats
  /** 选项取自库里的真实数据，不是前端硬编码的枚举。 */
  facets: { categories: AuditFacet[]; actions: AuditFacet[] }
}

/** 审计类接口共用的过滤条件；空值不会拼进查询串。 */
export interface AuditQuery {
  limit?: number
  offset?: number
  q?: string
  start?: string
  end?: string
  category?: string
  action?: string
  status?: string
  actor_type?: string
  project_id?: number
  source?: string
  agent_id?: number
  requirement_id?: number
  session_id?: number
}

function auditQuery(q?: AuditQuery): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q || {})) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** 操作日志检索：过滤、分页与统计由后端用同一套条件算出。 */
export const adminAuditLogs = (q?: AuditQuery) =>
  req(adminUrl(`/api/admin/audit-logs${auditQuery(q)}`)) as Promise<AuditLogPage>

// ---------------- 审计：Agent 调用留痕 ----------------

export type InvocationSource = 'session' | 'probe' | 'ai_cases' | 'ai_polish' | 'ai_design'

export const INVOCATION_SOURCE_LABELS: Record<string, string> = {
  session: '工作台会话',
  probe: '一键测试',
  ai_cases: 'AI 生成用例',
  ai_polish: 'AI 润色',
  ai_design: 'AI 设计文档',
}

export interface AgentInvocation {
  id: number
  source: InvocationSource
  agent_id: number | null
  agent_name: string
  agent_type: string
  /** 从 agent 配置解析出的模型名；没配就是空串。 */
  model: string
  project_id: number | null
  project_name: string
  requirement_id: number | null
  requirement_title: string
  session_id: number | null
  actor_type: string
  actor: string
  status: 'success' | 'error'
  error: string
  timed_out: number
  rate_limited: number
  /** 列表里只给开头，全文走详情接口。 */
  prompt_preview: string
  response_preview: string
  prompt_chars: number
  response_chars: number
  event_count: number
  elapsed_ms: number
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  /** 1 表示 token 用量是按字符估算的，不是模型回传的真实值。 */
  tokens_estimated: number
  created_at: string | null
}

export interface InvocationStats {
  total: number
  success: number
  error: number
  timed_out: number
  rate_limited: number
  total_tokens: number
  prompt_tokens: number
  completion_tokens: number
  /** 有多少条是估算出来的用量。 */
  estimated_rows: number
  elapsed_ms: number
  max_elapsed_ms: number
  avg_elapsed_ms: number
  by_source: Record<string, number>
}

export interface InvocationPage {
  total: number
  items: AgentInvocation[]
  stats: InvocationStats
  facets: { agents: { id: number; name: string; type: string }[] }
}

export const adminInvocations = (q?: AuditQuery) =>
  req(adminUrl(`/api/admin/invocations${auditQuery(q)}`)) as Promise<InvocationPage>

/** 单条调用的完整入参 / 出参。 */
export const adminInvocationDetail = (id: number) =>
  req(adminUrl(`/api/admin/invocations/${id}`)) as Promise<AgentInvocation & {
    prompt: string
    response: string
  }>
