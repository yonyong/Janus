import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import dayjs, { type Dayjs } from 'dayjs'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useAuth } from '../auth'
import {
  AdminOverview,
  AdminProject,
  AdminSession,
  AdminToken,
  ErrorInfo,
  adminBatchDeleteProjects,
  adminBatchDeleteSessions,
  adminBatchRevokeTokens,
  adminCreateProject,
  adminDeleteProject,
  adminDeleteSession,
  adminIssueToken,
  adminListProjects,
  adminListSessions,
  adminListTokens,
  adminOverview,
  adminRevealToken,
  adminRevokeToken,
  adminState,
  adminUpdateProject,
  adminUpdateToken,
  describeError,
  setAdminToken,
} from '../api'
import FolderPathInput from '../components/FolderPathInput'

/** 有效期预设：N 天 / 指定日期时刻 / 永不过期。 */
const TTL_PRESETS = [
  { label: '1 天', value: '1' },
  { label: '3 天', value: '3' },
  { label: '7 天', value: '7' },
  { label: '指定日期', value: 'custom' },
  { label: '永不过期', value: 'never' },
]

const DATE_FMT = 'YYYY-MM-DD HH:mm'

/** 三个 tab 列表共用：默认 10 条/页，可调整为 10/20/50/100（前端全量数据，客户端分页）。 */
const LIST_PAGINATION = {
  defaultPageSize: 10,
  showSizeChanger: true,
  pageSizeOptions: [10, 20, 50, 100],
  showTotal: (t: number) => `共 ${t} 条`,
}

/** 把 antd 的 mode + 日期换算成后端入参。 */
function expiryPayload(mode: string, date: Dayjs | null):
  | { ttl_days: number }
  | { expires_at: string }
  | Record<string, never> {
  if (mode === 'never') return {}
  if (mode === 'custom') {
    return date ? { expires_at: date.second(0).millisecond(0).format('YYYY-MM-DDTHH:mm:ss') } : {}
  }
  const d = Number(mode)
  return Number.isFinite(d) && d > 0 ? { ttl_days: d } : {}
}

function fmtTime(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '永不过期'
}

function AvatarIcon() {
  return (
    <span
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        background: 'linear-gradient(135deg,#4d7cff,#7b5cff)',
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <SafetyCertificateOutlined />
    </span>
  )
}

/** 概览统计：数据没取到时显示「—」，不用 0 冒充真实值。 */
function OverviewCards({ data, known }: { data: AdminOverview | null; known: boolean }) {
  const items = [
    { title: '项目', value: data?.projects, color: '#3370ff' },
    { title: '需求', value: data?.requirements },
    { title: '会话', value: data?.sessions },
    { title: '消息', value: data?.messages },
    { title: 'Agent', value: data?.agents },
    { title: '访问令牌', value: data?.tokens, color: '#7f3bf5' },
  ]
  return (
    <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
      {items.map((it) => (
        <Col xs={12} sm={8} xl={4} key={it.title}>
          <Card styles={{ body: { padding: 16 } }}>
            <Statistic
              title={it.title}
              value={known && it.value !== undefined ? it.value : '—'}
              valueStyle={{ fontSize: 22, color: known ? it.color : '#c9cdd4' }}
            />
          </Card>
        </Col>
      ))}
    </Row>
  )
}

/** 错误引导条：说清发生了什么，并给出可以直接点的下一步。 */
function ErrorGuide({
  info,
  onRetry,
  onRelock,
  onHome,
  retryText = '重试',
}: {
  info: ErrorInfo
  onRetry?: () => void
  onRelock?: () => void
  onHome?: () => void
  retryText?: string
}) {
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 16, borderRadius: 10 }}
      message={info.title}
      description={
        <div>
          {info.hint && <div>{info.hint}</div>}
          {info.detail && (
            <div style={{ marginTop: 4, fontSize: 12, color: '#8f959e' }}>接口返回：{info.detail}</div>
          )}
          <Space style={{ marginTop: 10 }}>
            {onRetry && (
              <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
                {retryText}
              </Button>
            )}
            {onRelock && (
              <Button size="small" onClick={onRelock}>
                重新输入管理员口令
              </Button>
            )}
            {onHome && (
              <Button size="small" type="link" onClick={onHome}>
                回到工作台
              </Button>
            )}
          </Space>
        </div>
      }
    />
  )
}

/** 管理台：项目 / 令牌 / 会话 的统一管理入口，需管理员口令解锁。 */
export default function AdminConsole() {
  const navigate = useNavigate()
  const { message, modal } = AntdApp.useApp()

  const [enabled, setEnabled] = useState<boolean | null>(null)
  // 管理员口令统一由全局登录态持有：这里解锁/锁定写的就是登录弹框用的那一份凭证，
  // 两边不再各存一份，避免「管理台锁了但顶栏还显示管理员」这类不一致。
  const { admin, openLogin } = useAuth()
  const pwd = admin || ''
  const [unlocked, setUnlocked] = useState(false)
  const [checking, setChecking] = useState(false)
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [projects, setProjects] = useState<AdminProject[]>([])
  const [tokens, setTokens] = useState<AdminToken[]>([])
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ErrorInfo | null>(null)
  const [stateError, setStateError] = useState<ErrorInfo | null>(null)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  // 三个 Tab 各自的勾选批量删除
  const [selProjects, setSelProjects] = useState<number[]>([])
  const [selTokens, setSelTokens] = useState<number[]>([])
  const [selSessions, setSelSessions] = useState<number[]>([])
  const [batchBusy, setBatchBusy] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [editProjectOpen, setEditProjectOpen] = useState(false)
  const [editProjectTarget, setEditProjectTarget] = useState<AdminProject | null>(null)
  const [editProjectSaving, setEditProjectSaving] = useState(false)
  const [editProjectForm] = Form.useForm()
  const [issueOpen, setIssueOpen] = useState(false)
  const [issueResult, setIssueResult] = useState<{
    token: string
    link: string
    expires_at: string | null
    note: string
  } | null>(null)
  const [issueMode, setIssueMode] = useState<string>('7')
  const [issueDate, setIssueDate] = useState<Dayjs | null>(null)
  const [form] = Form.useForm()
  const [issueForm] = Form.useForm()

  // 令牌：查看完整原文 / 编辑备注与有效期
  const [revealOpen, setRevealOpen] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [revealTarget, setRevealTarget] = useState<AdminToken | null>(null)
  const [revealed, setRevealed] = useState<AdminToken | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AdminToken | null>(null)
  const [editMode, setEditMode] = useState<string>('keep')
  const [editDate, setEditDate] = useState<Dayjs | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editForm] = Form.useForm()

  const lock = useCallback(
    (reason?: string) => {
      setAdminToken(null)
      setUnlocked(false)
      setUnlockError(reason || null)
    },
    [],
  )

  const loadAll = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [ov, ps, ts, ss] = await Promise.all([
        adminOverview(),
        adminListProjects(),
        adminListTokens(),
        adminListSessions(),
      ])
      setOverview(ov)
      setProjects(ps)
      setTokens(ts)
      setSessions(ss)
      setSelProjects([])
      setSelTokens([])
      setSelSessions([])
    } catch (e) {
      const info = describeError(e)
      setLoadError(info)
      if (info.status === 401) {
        // 口令失效：退回解锁页，并把原因带过去
        lock(`上一次使用的管理员口令已失效：${info.detail || info.title}`)
      } else {
        message.error(info.message)
      }
    } finally {
      setLoading(false)
    }
  }, [lock, message])

  const fetchState = useCallback(async () => {
    setStateError(null)
    try {
      const s = await adminState()
      setEnabled(s.admin_enabled)
      return s.admin_enabled
    } catch (e) {
      // 不要把「连不上后端」伪装成「开放模式」
      const info = describeError(e)
      setEnabled(false)
      setStateError(info)
      return null
    }
  }, [])

  useEffect(() => {
    void fetchState()
  }, [fetchState])

  useEffect(() => {
    if (enabled === null) return
    if (!enabled) {
      setUnlocked(true)
      loadAll()
      return
    }
    if (!pwd) {
      setLoading(false)
      return
    }
    setChecking(true)
    adminOverview()
      .then(() => {
        setUnlocked(true)
        loadAll()
      })
      .catch((e) => {
        const info = describeError(e)
        setLoading(false)
        lock(info.status === 401 ? '管理员口令不正确或已失效，请重新输入。' : info.message)
      })
      .finally(() => setChecking(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pwd])

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      message.success('已复制')
    } catch {
      message.warning('复制失败，请手动选择')
    }
  }

  const submitProject = async () => {
    const v = await form.validateFields()
    try {
      await adminCreateProject({ name: v.name.trim(), disk_path: v.disk_path.trim() })
      message.success('项目已创建')
      setCreateOpen(false)
      form.resetFields()
      loadAll()
    } catch (e) {
      message.error(describeError(e).message)
    }
  }

  /** 编辑项目信息：名称与本地工程路径。路径改动会立即影响该项目的文件面板与 agent 工作目录。 */
  const openEditProject = (p: AdminProject) => {
    setEditProjectTarget(p)
    editProjectForm.setFieldsValue({ name: p.name, disk_path: p.disk_path })
    setEditProjectOpen(true)
  }

  const submitEditProject = async () => {
    if (!editProjectTarget) return
    const v = await editProjectForm.validateFields()
    const name = (v.name || '').trim()
    const disk_path = (v.disk_path || '').trim()
    if (name === editProjectTarget.name && disk_path === editProjectTarget.disk_path) {
      setEditProjectOpen(false)
      return
    }
    setEditProjectSaving(true)
    try {
      await adminUpdateProject(editProjectTarget.id, { name, disk_path })
      message.success('项目已更新')
      setEditProjectOpen(false)
      loadAll()
    } catch (e) {
      message.error(describeError(e).message)
    } finally {
      setEditProjectSaving(false)
    }
  }

  const submitIssue = async () => {
    const v = await issueForm.validateFields()
    if (issueMode === 'custom' && !issueDate) {
      message.warning('请选择具体的过期日期与时间')
      return
    }
    try {
      const r = await adminIssueToken({
        project_ids: v.project_ids || [],
        note: (v.note || '').trim(),
        ...expiryPayload(issueMode, issueDate),
      })
      setIssueResult({ token: r.token, link: r.link, expires_at: r.expires_at, note: r.note || '' })
      message.success('令牌已签发')
      loadAll()
    } catch (e) {
      message.error(describeError(e).message)
    }
  }

  /** 已签发的令牌仍可查看原文，而不是只在签发瞬间可见一次。 */
  const revealToken = async (id: number) => {
    setRevealing(true)
    setRevealed(null)
    setRevealOpen(true)
    try {
      setRevealed(await adminRevealToken(id))
    } catch (e) {
      setRevealOpen(false)
      message.error(describeError(e).message)
    } finally {
      setRevealing(false)
    }
  }

  const openEditToken = (r: AdminToken) => {
    setEditTarget(r)
    setEditMode('keep')
    setEditDate(r.expires_at ? dayjs(r.expires_at) : null)
    editForm.setFieldsValue({ note: r.note || '' })
    setEditOpen(true)
  }

  const submitEditToken = async () => {
    if (!editTarget) return
    const v = await editForm.validateFields()
    if (editMode === 'custom' && !editDate) {
      message.warning('请选择具体的过期日期与时间')
      return
    }
    setEditSaving(true)
    try {
      const payload: Record<string, unknown> = { note: (v.note || '').trim() }
      if (editMode === 'never') payload.never_expires = true
      else if (editMode !== 'keep') Object.assign(payload, expiryPayload(editMode, editDate))
      await adminUpdateToken(editTarget.id, payload as any)
      message.success('已保存')
      setEditOpen(false)
      loadAll()
    } catch (e) {
      message.error(describeError(e).message)
    } finally {
      setEditSaving(false)
    }
  }

  const removeProject = async (id: number) => {
    try {
      await adminDeleteProject(id)
      message.success('已删除')
      loadAll()
    } catch (e) {
      message.error(describeError(e).message)
    }
  }

  const removeToken = async (id: number) => {
    try {
      await adminRevokeToken(id)
      message.success('已吊销')
      loadAll()
    } catch (e) {
      message.error(describeError(e).message)
    }
  }

  const removeSession = async (id: number) => {
    try {
      await adminDeleteSession(id)
      message.success('已删除')
      loadAll()
    } catch (e) {
      message.error(describeError(e).message)
    }
  }

  const confirmBatchProjects = () => {
    if (!selProjects.length) return
    const n = selProjects.length
    modal.confirm({
      title: `删除选中的 ${n} 个项目？`,
      content: '删除后不可撤销，相关需求与会话数据也会一并失去入口。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBatchBusy(true)
        try {
          const r = await adminBatchDeleteProjects(selProjects)
          message.success(`已删除 ${r.deleted} 个项目`)
          await loadAll()
        } catch (e) {
          message.error(describeError(e).message)
        } finally {
          setBatchBusy(false)
        }
      },
    })
  }

  const confirmBatchTokens = () => {
    if (!selTokens.length) return
    const n = selTokens.length
    modal.confirm({
      title: `吊销选中的 ${n} 个令牌？`,
      content: '持有者将立即失去访问权。',
      okText: '吊销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBatchBusy(true)
        try {
          const r = await adminBatchRevokeTokens(selTokens)
          message.success(`已吊销 ${r.deleted} 个令牌`)
          await loadAll()
        } catch (e) {
          message.error(describeError(e).message)
        } finally {
          setBatchBusy(false)
        }
      },
    })
  }

  const confirmBatchSessions = () => {
    if (!selSessions.length) return
    const n = selSessions.length
    modal.confirm({
      title: `删除选中的 ${n} 个会话？`,
      content: '会话消息与关联改动记录会一并清除，不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBatchBusy(true)
        try {
          const r = await adminBatchDeleteSessions(selSessions)
          message.success(`已删除 ${r.deleted} 个会话`)
          await loadAll()
        } catch (e) {
          message.error(describeError(e).message)
        } finally {
          setBatchBusy(false)
        }
      },
    })
  }

  const openIssue = (defaultIds?: number[]) => {
    setIssueResult(null)
    setIssueMode('7')
    setIssueDate(null)
    issueForm.setFieldsValue({
      project_ids: defaultIds?.length ? defaultIds : projects.map((p) => p.id),
      note: '',
    })
    setIssueOpen(true)
  }

  const projectColumns = [
    { title: 'ID', dataIndex: 'id', width: 70, render: (v: number) => <Tag color="blue">#{v}</Tag> },
    { title: '名称', dataIndex: 'name', width: 170, ellipsis: true, render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    {
      title: '本地路径',
      dataIndex: 'disk_path',
      width: 340,
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <Typography.Text code style={{ fontSize: 12 }}>
            {v}
          </Typography.Text>
        </Tooltip>
      ),
    },
    { title: '需求', dataIndex: 'requirements', width: 80 },
    { title: '会话', dataIndex: 'sessions', width: 80 },
    {
      title: '操作',
      width: 230,
      render: (_: any, r: AdminProject) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => navigate(`/projects/${r.id}`)}>
            需求
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEditProject(r)}>
            编辑
          </Button>
          <Button type="link" size="small" onClick={() => openIssue([r.id])}>
            签发
          </Button>
          <Popconfirm
            title="删除该项目？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeProject(r.id)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const tokenColumns = [
    { title: 'ID', dataIndex: 'id', width: 56, render: (v: number) => <Tag>#{v}</Tag> },
    {
      title: '令牌',
      dataIndex: 'masked',
      width: 150,
      ellipsis: true,
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    {
      title: '备注',
      dataIndex: 'note',
      width: 180,
      render: (v: string) =>
        v ? (
          <Tooltip title={v}>
            <Typography.Text ellipsis style={{ maxWidth: 160, fontSize: 13 }}>
              {v}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            未填写
          </Typography.Text>
        ),
    },
    {
      title: '授权项目',
      dataIndex: 'project_ids',
      width: 170,
      ellipsis: true,
      render: (ids: number[]) => (
        <Tooltip title={ids.length ? ids.map((i) => `#${i}`).join(' ') : '无授权项目'}>
          <Space size={4} style={{ flexWrap: 'nowrap' }}>
            {ids.length === 0 ? <Tag>无</Tag> : ids.map((i) => <Tag key={i} color="blue">#{i}</Tag>)}
          </Space>
        </Tooltip>
      ),
    },
    {
      title: '签发时间',
      dataIndex: 'created_at',
      width: 150,
      render: (v: string | null) => <span style={{ fontSize: 12 }}>{v ? v.replace('T', ' ') : '—'}</span>,
    },
    {
      title: '过期时间',
      dataIndex: 'expires_at',
      width: 150,
      render: (v: string | null) => (
        <span style={{ fontSize: 12, color: v ? undefined : '#8f959e' }}>{fmtTime(v)}</span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'expired',
      width: 84,
      render: (v: boolean) => (v ? <Tag color="error">已过期</Tag> : <Tag color="success">有效</Tag>),
    },
    {
      title: '操作',
      width: 180,
      render: (_: any, r: AdminToken) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => revealToken(r.id)}>
            查看
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEditToken(r)}>
            编辑
          </Button>
          <Popconfirm
            title="吊销该令牌？"
            description="持有者将立即失去访问权"
            okText="吊销"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeToken(r.id)}
          >
            <Button type="link" size="small" danger>
              吊销
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const sessionColumns = [
    { title: 'ID', dataIndex: 'id', width: 70, render: (v: number) => <Tag>#{v}</Tag> },
    { title: '需求', dataIndex: 'requirement', width: 240, ellipsis: true, render: (v: string | null) => v || '—' },
    { title: '项目', dataIndex: 'project', width: 180, ellipsis: true, render: (v: string | null) => v || '—' },
    { title: '消息', dataIndex: 'messages', width: 80 },
    {
      title: '分支',
      dataIndex: 'git_branch',
      width: 180,
      ellipsis: true,
      render: (v: string | null) => (v ? <Typography.Text code>{v}</Typography.Text> : <span style={{ color: '#8f959e' }}>—</span>),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 160, render: (v: string | null) => <span style={{ fontSize: 12 }}>{v || '—'}</span> },
    {
      title: '操作',
      width: 140,
      render: (_: any, r: AdminSession) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            icon={<ThunderboltOutlined />}
            onClick={() => navigate(`/workbench/${r.id}?pid=${r.project_id ?? ''}&rid=${r.requirement_id ?? ''}`)}
          >
            打开
          </Button>
          <Popconfirm
            title="删除该会话？"
            description="消息与关联改动记录会一并清除"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeSession(r.id)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  if (enabled === null) {
    return stateError ? (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <ErrorGuide info={stateError} onRetry={() => void fetchState()} retryText="重新检测后端" />
      </div>
    ) : (
      <Card>
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      </Card>
    )
  }

  if (enabled && !unlocked) {
    return (
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <Card>
          <Space align="center" size={10} style={{ marginBottom: 12 }}>
            <AvatarIcon />
            <Typography.Title level={4} style={{ margin: 0 }}>
              管理台
            </Typography.Title>
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
            管理台需要管理员口令。当前是以访问令牌登录的，只能看到被授权的项目。
          </Typography.Paragraph>
          {unlockError && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="管理员登录失败" description={unlockError} />
          )}
          <Button
            type="primary"
            block
            size="large"
            loading={checking}
            onClick={() => openLogin('admin')}
          >
            用管理员口令登录
          </Button>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            口令配置在 <Typography.Text code>coding-agent-platform/.env</Typography.Text> 的{' '}
            <Typography.Text code>CAP_ADMIN_TOKEN</Typography.Text>。登录后可见全部项目。
          </Typography.Paragraph>
        </Card>
      </div>
    )
  }

  return (
    <div style={{ width: '100%', maxWidth: 1440, margin: '0 auto' }}>
      <Card styles={{ body: { padding: '20px 24px' } }} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <Space align="center" size={8}>
              <AvatarIcon />
              <Typography.Title level={4} style={{ margin: 0 }}>
                管理台
              </Typography.Title>
              <Tag color={stateError ? 'red' : enabled ? 'green' : 'orange'}>
                {stateError ? '后端不可达' : enabled ? '口令已启用' : '开放模式'}
              </Tag>
            </Space>
            <div style={{ color: '#8f959e', fontSize: 13, marginTop: 4 }}>
              新建 / 编辑 / 删除项目，签发与吊销访问令牌，查看会话记录
            </div>
          </div>
          <Space>
            {enabled && (
              <Button icon={<SafetyCertificateOutlined />} onClick={() => lock()}>
                锁定
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={loadAll} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<KeyOutlined />} onClick={() => openIssue()}>
              签发令牌
            </Button>
          </Space>
        </div>
      </Card>

      {stateError && (
        <ErrorGuide
          info={stateError}
          onRetry={() => {
            void fetchState().then((v) => {
              if (v !== null) loadAll()
            })
          }}
          retryText="重新检测后端"
        />
      )}

      {!enabled && !stateError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="未启用管理员口令"
          description="当前管理端点对可访问本机端口的任何人开放。在 coding-agent-platform/.env 中设置 CAP_ADMIN_TOKEN 后重启后端即可启用。"
        />
      )}

      {loadError && (
        <ErrorGuide
          info={loadError}
          onRetry={loadAll}
          onRelock={loadError.status === 401 && enabled ? () => lock() : undefined}
          onHome={() => navigate('/')}
        />
      )}

      <OverviewCards data={overview} known={!loadError} />

      <Card style={{ width: '100%' }}>
        <Tabs
          items={[
            {
              key: 'projects',
              label: `项目 ${loadError ? '—' : projects.length}`,
              children: (
                <div style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      disabled={!selProjects.length}
                      loading={batchBusy}
                      onClick={confirmBatchProjects}
                    >
                      删除选中{selProjects.length ? `（${selProjects.length}）` : ''}
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                      新建项目
                    </Button>
                  </div>
                  <Table
                    rowKey="id"
                    size="small"
                    className="tbl-nowrap"
                    tableLayout="fixed"
                    loading={loading}
                    dataSource={projects}
                    columns={projectColumns}
                    rowSelection={{
                      selectedRowKeys: selProjects,
                      onChange: (keys) => setSelProjects(keys as number[]),
                    }}
                    style={{ width: '100%' }}
                    scroll={{ x: true }}
                    pagination={{ ...LIST_PAGINATION }}
                    locale={{ emptyText: <Empty description={loadError ? '数据未加载成功，请点上方「重试」' : '暂无项目'} /> }}
                  />
                </div>
              ),
            },
            {
              key: 'tokens',
              label: `令牌 ${loadError ? '—' : tokens.length}`,
              children: (
                <div style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      disabled={!selTokens.length}
                      loading={batchBusy}
                      onClick={confirmBatchTokens}
                    >
                      吊销选中{selTokens.length ? `（${selTokens.length}）` : ''}
                    </Button>
                  </div>
                  <Table
                    rowKey="id"
                    size="small"
                    className="tbl-nowrap"
                    tableLayout="fixed"
                    loading={loading}
                    dataSource={tokens}
                    columns={tokenColumns}
                    rowSelection={{
                      selectedRowKeys: selTokens,
                      onChange: (keys) => setSelTokens(keys as number[]),
                    }}
                    style={{ width: '100%' }}
                    scroll={{ x: true }}
                    pagination={{ ...LIST_PAGINATION }}
                    locale={{ emptyText: <Empty description={loadError ? '数据未加载成功，请点上方「重试」' : '暂无令牌'} /> }}
                  />
                </div>
              ),
            },
            {
              key: 'sessions',
              label: `会话 ${loadError ? '—' : sessions.length}`,
              children: (
                <div style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      disabled={!selSessions.length}
                      loading={batchBusy}
                      onClick={confirmBatchSessions}
                    >
                      删除选中{selSessions.length ? `（${selSessions.length}）` : ''}
                    </Button>
                  </div>
                  <Table
                    rowKey="id"
                    size="small"
                    className="tbl-nowrap"
                    tableLayout="fixed"
                    loading={loading}
                    dataSource={sessions}
                    columns={sessionColumns}
                    rowSelection={{
                      selectedRowKeys: selSessions,
                      onChange: (keys) => setSelSessions(keys as number[]),
                    }}
                    style={{ width: '100%' }}
                    scroll={{ x: true }}
                    pagination={{ ...LIST_PAGINATION }}
                    locale={{ emptyText: <Empty description={loadError ? '数据未加载成功，请点上方「重试」' : '暂无会话'} /> }}
                  />
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="新建项目"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={submitProject}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }} requiredMark={false}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
            <Input placeholder="例如：Janus 前端" />
          </Form.Item>
          <Form.Item
            name="disk_path"
            label="本地工程路径"
            rules={[{ required: true, message: '请输入本地磁盘绝对路径' }]}
            extra="路径必须已存在于后端运行的本机"
          >
            <FolderPathInput placeholder="D:/dev/my-project" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`编辑项目 · #${editProjectTarget?.id ?? ''}`}
        open={editProjectOpen}
        onCancel={() => setEditProjectOpen(false)}
        onOk={submitEditProject}
        okText="保存"
        cancelText="取消"
        confirmLoading={editProjectSaving}
      >
        <Form form={editProjectForm} layout="vertical" style={{ marginTop: 16 }} requiredMark={false}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
            <Input placeholder="例如：Janus 前端" />
          </Form.Item>
          <Form.Item
            name="disk_path"
            label="本地工程路径"
            rules={[{ required: true, message: '请输入本地磁盘绝对路径' }]}
            extra="保存后立即生效：该项目的文件面板、代码 diff 与会话工作目录都会指向新路径"
          >
            <FolderPathInput placeholder="D:/dev/my-project" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="签发访问令牌"
        open={issueOpen}
        onCancel={() => setIssueOpen(false)}
        footer={null}
      >
        {issueResult ? (
          <div>
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message="令牌已签发"
              description={
                <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                  <span>过期时间：{fmtTime(issueResult.expires_at)}</span>
                  <span>备注：{issueResult.note || '（未填写）'}</span>
                  <span>关闭后仍可在「令牌」页用「查看」按钮再次拿到原文。</span>
                </Space>
              }
            />
            <Input.Search value={issueResult.link} readOnly enterButton={<CopyOutlined />} onSearch={() => copy(issueResult.link)} />
            <div style={{ textAlign: 'right', marginTop: 14 }}>
              <Button
                type="primary"
                onClick={() => {
                  setIssueOpen(false)
                  setIssueResult(null)
                }}
              >
                我已保存
              </Button>
            </div>
          </div>
        ) : (
          <Form form={issueForm} layout="vertical" style={{ marginTop: 16 }} requiredMark={false}>
            <Form.Item
              name="project_ids"
              label="授权范围"
              rules={[{ required: true, message: '请至少选择一个项目' }]}
            >
              <Select
                mode="multiple"
                placeholder="选择可访问的项目"
                options={projects.map((p) => ({ value: p.id, label: `${p.name} (#${p.id})` }))}
              />
            </Form.Item>
            <Form.Item name="note" label="备注">
              <Input
                placeholder="给这条令牌写个用途说明，例如「给张三临时试用」"
                maxLength={100}
                showCount
              />
            </Form.Item>
            <Form.Item
              label="有效期"
              extra={
                issueMode === 'custom'
                  ? '过期时刻按本机时区计算，到期后持有者立即无法访问'
                  : issueMode === 'never'
                    ? '长期有效，直到你在令牌列表里手动吊销'
                    : `自签发起 ${issueMode} 天后过期`
              }
            >
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Segmented value={issueMode} onChange={(v) => setIssueMode(String(v))} options={TTL_PRESETS} />
                {issueMode === 'custom' && (
                  <DatePicker
                    showTime={{ format: 'HH:mm' }}
                    format={DATE_FMT}
                    value={issueDate}
                    onChange={setIssueDate}
                    disabledDate={(c) => c.isBefore(dayjs().startOf('day'))}
                    placeholder="选择到期日期与时间"
                    style={{ width: '100%' }}
                  />
                )}
              </Space>
            </Form.Item>
            <div style={{ textAlign: 'right' }}>
              <Space>
                <Button onClick={() => setIssueOpen(false)}>取消</Button>
                <Button type="primary" icon={<KeyOutlined />} onClick={submitIssue}>
                  签发
                </Button>
              </Space>
            </div>
          </Form>
        )}
      </Modal>

      <Modal
        title={`令牌原文 · #${revealTarget?.id ?? ''}`}
        open={revealOpen}
        onCancel={() => setRevealOpen(false)}
        footer={[
          <Button key="close" onClick={() => setRevealOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        {revealing || !revealed ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : (
          <div>
            <Descriptions column={1} size="small" styles={{ label: { width: 84 } }}>
              <Descriptions.Item label="备注">{revealed.note || '（未填写）'}</Descriptions.Item>
              <Descriptions.Item label="授权项目">
                <Space size={4} wrap>
                  {revealed.project_ids.length === 0 ? (
                    <Tag>无</Tag>
                  ) : (
                    revealed.project_ids.map((i) => (
                      <Tag key={i} color="blue">
                        #{i}
                      </Tag>
                    ))
                  )}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="过期时间">
                {fmtTime(revealed.expires_at)}
                {revealed.expired && <Tag color="error" style={{ marginLeft: 8 }}>已过期</Tag>}
              </Descriptions.Item>
            </Descriptions>
            <div style={{ margin: '12px 0 6px', fontSize: 13 }}>完整令牌</div>
            <Input.Search value={revealed.token} readOnly enterButton={<CopyOutlined />} onSearch={() => copy(revealed.token || '')} />
            <div style={{ margin: '12px 0 6px', fontSize: 13 }}>分享链接</div>
            <Input.Search value={revealed.link} readOnly enterButton={<CopyOutlined />} onSearch={() => copy(revealed.link || '')} />
          </div>
        )}
      </Modal>

      <Modal
        title={`编辑令牌 · #${editTarget?.id ?? ''}`}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        okText="保存"
        cancelText="取消"
        confirmLoading={editSaving}
        onOk={submitEditToken}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }} requiredMark={false}>
          <Form.Item name="note" label="备注" extra="用于区分这条令牌发给谁、做什么用">
            <Input.TextArea rows={2} maxLength={100} showCount placeholder="例如：给外包同事审查 demo 项目，月底前有效" />
          </Form.Item>
          <Form.Item label="有效期" extra={editMode === 'keep' ? '保持当前设置不变' : '保存后立即生效'}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Segmented
                value={editMode}
                onChange={(v) => setEditMode(String(v))}
                options={[
                  { label: '保持不变', value: 'keep' },
                  { label: '1 天', value: '1' },
                  { label: '3 天', value: '3' },
                  { label: '7 天', value: '7' },
                  { label: '指定日期', value: 'custom' },
                  { label: '永不过期', value: 'never' },
                ]}
              />
              {editMode === 'custom' && (
                <DatePicker
                  showTime={{ format: 'HH:mm' }}
                  format={DATE_FMT}
                  value={editDate}
                  onChange={setEditDate}
                  disabledDate={(c) => c.isBefore(dayjs().startOf('day'))}
                  placeholder="选择到期日期与时间"
                  style={{ width: '100%' }}
                />
              )}
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
