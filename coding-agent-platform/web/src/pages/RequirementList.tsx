import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  App as AntdApp,
  Breadcrumb,
  Button,
  Card,
  Col,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  MoreOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useToken } from '../auth'
import { useSearch } from '../context'
import {
  createRequirement,
  createSession,
  deleteRequirement,
  listProjects,
  listRequirements,
  requirementWorkflow,
  Requirement,
  Stage,
  STAGE_LABELS,
  WorkflowState,
} from '../api'

/** 需求标题降噪：拆出后端自动加的 v-时间戳- 前缀，主体名做主标题，前缀弱化展示。 */
function splitReqTitle(title: string): { prefix: string; name: string } {
  const m = /^v-(\d{14})-(.+)$/.exec(title)
  return m ? { prefix: m[1], name: m[2] } : { prefix: '', name: title }
}

/** 工作流阶段标签配色。 */
const STAGE_TAG_COLORS: Record<Stage, string> = {
  clarify: 'blue',
  verify: 'orange',
  build: 'cyan',
  archive: 'green',
}

/** 时间展示：统一成 "YYYY-MM-DD HH:mm"，created_at 缺失时用标题 v-时间戳- 前缀兜底。 */
function fmtTime(s?: string | null, prefixFallback?: string): string {
  let raw = s || ''
  if ((!raw || !/^\d{4}-/.test(raw)) && prefixFallback && /^\d{14}$/.test(prefixFallback)) {
    const p = prefixFallback
    raw = `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)} ${p.slice(8, 10)}:${p.slice(10, 12)}:${p.slice(12, 14)}`
  }
  return raw.replace('T', ' ').slice(0, 16)
}

export default function RequirementList() {
  const { pid } = useParams()
  const projectId = Number(pid)
  const token = useToken()
  const navigate = useNavigate()
  const { kw } = useSearch()
  const { message, modal } = AntdApp.useApp()
  const [reqs, setReqs] = useState<Requirement[]>([])
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  // 「从已有会话进入」选择器：进入有历史会话的需求时先问一下怎么进
  const [pickOpen, setPickOpen] = useState(false)
  const [pickReq, setPickReq] = useState<Requirement | null>(null)
  const [pickSessions, setPickSessions] = useState<WorkflowState['sessions']>([])
  const [form] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      const [rs, ps] = await Promise.all([
        listRequirements(token, projectId),
        listProjects(token).catch(() => []),
      ])
      setReqs(rs)
      const p = ps.find((x) => String(x.id) === String(pid))
      setProjectName(p?.name || `项目 #${pid}`)
      setProjectPath(p?.disk_path || '')
    } catch (e: any) {
      message.error(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])

  const visible = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return reqs
    return reqs.filter(
      (r) => r.title.toLowerCase().includes(k) || (r.description || '').toLowerCase().includes(k),
    )
  }, [reqs, kw])

  const submit = async () => {
    const v = await form.validateFields()
    try {
      await createRequirement(token, projectId, {
        title: v.title.trim(),
        description: (v.description || '').trim(),
      })
      message.success('需求已创建')
      setCreateOpen(false)
      form.resetFields()
      load()
    } catch (e: any) {
      message.error(String(e.message || e))
    }
  }

  /** 直接开一个新会话进入工作台。 */
  const createAndEnter = async (rid: number) => {
    try {
      const s = await createSession(token, rid)
      navigate(`/workbench/${s.id}?pid=${projectId}&rid=${rid}`)
    } catch (e: any) {
      message.error(String(e.message || e))
      setBusyId(null)
    }
  }

  /**
   * 进入需求：没有历史会话时直接新建（与旧行为一致）；已有会话时先弹选择器，
   * 让用户决定「开新会话」还是「继续某个已有会话」——避免每次进入都悄悄
   * 新建会话、切新分支，把上下文散落在几十个会话里。
   */
  const enter = async (r: Requirement) => {
    setBusyId(r.id)
    try {
      const f = await requirementWorkflow(token, r.id)
      if (!f.sessions.length) {
        await createAndEnter(r.id)
        return
      }
      setPickReq(r)
      setPickSessions([...f.sessions].reverse()) // 新会话在前，最近用过的先看到
      setPickOpen(true)
      setBusyId(null)
    } catch (e: any) {
      message.error(String(e.message || e))
      setBusyId(null)
    }
  }

  const confirmDelete = (r: Requirement) => {
    modal.confirm({
      title: '删除该需求？',
      content: `「${splitReqTitle(r.title).name}」删除后不可恢复`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteRequirement(token, r.id)
        message.success('已删除')
        load()
      },
    })
  }

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto' }}>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[
          { title: <a onClick={() => navigate('/projects')}>项目空间</a> },
          { title: projectName || '项目' },
        ]}
      />

      <Card styles={{ body: { padding: '20px 24px' } }} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <Space align="center" size={8}>
              <Typography.Title level={4} style={{ margin: 0 }} ellipsis>
                {projectName}
              </Typography.Title>
              <Tag color="blue">{reqs.length} 个需求</Tag>
            </Space>
            {projectPath && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }} code>
                {projectPath}
              </Typography.Text>
            )}
          </div>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/projects')}>
              返回
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建需求
            </Button>
          </Space>
        </div>
      </Card>

      {loading ? (
        <Row gutter={[16, 16]}>
          {[0, 1, 2].map((i) => (
            <Col xs={24} md={12} xl={8} key={i}>
              <Card>
                <Skeleton active title paragraph={{ rows: 2 }} />
              </Card>
            </Col>
          ))}
        </Row>
      ) : visible.length === 0 ? (
        <Card styles={{ body: { padding: '48px 24px' } }}>
          <Empty description={kw ? '没有匹配的需求' : '还没有需求，写下第一条，让创意落地生花'}>
            {!kw && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                新建需求
              </Button>
            )}
          </Empty>
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {visible.map((r) => {
            const t = splitReqTitle(r.title)
            const stage = (r.stage || 'clarify') as Stage
            const createdAt = fmtTime(r.created_at, t.prefix)
            const updatedAt = fmtTime(r.updated_at, t.prefix)
            return (
              <Col xs={24} md={12} xl={8} key={r.id} style={{ display: 'flex' }}>
                <Card
                  className="app-tile req-tile"
                  styles={{ body: { padding: 18 } }}
                  style={{ width: '100%' }}
                  title={
                    <div style={{ minWidth: 0 }}>
                      <Space size={6} style={{ maxWidth: '100%' }}>
                        <ThunderboltOutlined style={{ color: '#3370ff', flex: 'none' }} />
                        <Typography.Text ellipsis={{ tooltip: r.title }} strong style={{ fontSize: 14 }}>
                          {t.name}
                        </Typography.Text>
                      </Space>
                    </div>
                  }
                  extra={
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'del', icon: <DeleteOutlined />, label: '删除需求', danger: true },
                        ],
                        onClick: ({ key }) => {
                          if (key === 'del') confirmDelete(r)
                        },
                      }}
                    >
                      <Button type="text" size="small" icon={<MoreOutlined />} />
                    </Dropdown>
                  }
                  actions={[
                    <Button
                      key="enter"
                      type="link"
                      loading={busyId === r.id}
                      onClick={() => enter(r)}
                      icon={<ThunderboltOutlined />}
                    >
                      {busyId === r.id ? '进入中…' : '进入工作台'}
                    </Button>,
                  ]}
                >
                  {/* 描述固定 4 行高度：同行卡片等高，底部操作对齐 */}
                  <div className="req-tile-desc">
                    <Tooltip title={r.description ? <span style={{ whiteSpace: 'pre-wrap' }}>{r.description}</span> : ''}>
                      <span>{r.description || ''}</span>
                    </Tooltip>
                    {!r.description && <Typography.Text type="secondary">（无描述）</Typography.Text>}
                  </div>
                  {/* 状态 + 时间元信息行 */}
                  <div
                    className="req-tile-meta"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 'auto',
                      paddingTop: 12,
                      borderTop: '1px solid #f0f1f2',
                      flexWrap: 'wrap',
                    }}
                  >
                    <Tag color={STAGE_TAG_COLORS[stage]} style={{ marginInlineEnd: 0 }}>
                      {STAGE_LABELS[stage]}
                    </Tag>
                    {r.mode === 'lite' && (
                      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                        轻量
                      </Tag>
                    )}
                    {stage === 'archive' && r.verdict === 'accepted' && (
                      <Tag color="green" style={{ marginInlineEnd: 0 }}>
                        验收通过
                      </Tag>
                    )}
                    {stage === 'archive' && r.verdict === 'rejected' && (
                      <Tag color="red" style={{ marginInlineEnd: 0 }}>
                        验收不通过
                      </Tag>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                      创建 {createdAt}
                      {updatedAt !== createdAt ? ` · 更新 ${updatedAt}` : ''}
                    </Typography.Text>
                  </div>
                </Card>
              </Col>
            )
          })}
        </Row>
      )}

      <Modal
        title="新建需求"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={submit}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }} requiredMark={false}>
          <Form.Item
            name="title"
            label="需求标题"
            rules={[{ required: true, message: '请输入需求标题' }]}
            extra="创建后自动添加 v-时间戳- 前缀（如 v-20260919041657-），只需填写标题本身"
          >
            <Input placeholder="例如：新增登录验证码校验" />
          </Form.Item>
          <Form.Item name="description" label="需求描述" extra="写得越具体，Agent 拆解与编码越准确" style={{ marginBottom: 0 }}>
            <Input.TextArea rows={4} placeholder="补充背景、验收标准、影响范围…" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={pickReq ? `进入「${splitReqTitle(pickReq.title).name}」` : '进入需求'}
        open={pickOpen}
        onCancel={() => setPickOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setPickOpen(false)}>
            取消
          </Button>,
          <Button
            key="new"
            type="primary"
            icon={<PlusOutlined />}
            loading={pickReq !== null && busyId === pickReq.id}
            onClick={() => pickReq && createAndEnter(pickReq.id)}
          >
            新建会话进入
          </Button>,
        ]}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          该需求已有 {pickSessions.length} 个会话：继续旧会话可沿用之前的对话与改动上下文；
          开新会话则从干净状态开始（会切一个新的工作分支）。
        </Typography.Paragraph>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pickSessions.map((s) => (
            <div
              key={s.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                border: '1px solid #e5e6eb',
                borderRadius: 8,
                padding: '8px 12px',
              }}
            >
              <Space size={8} wrap style={{ minWidth: 0 }}>
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  会话 #{s.id}
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.created_at ? s.created_at.replace('T', ' ').slice(0, 19) : '—'}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.messages} 条消息
                </Typography.Text>
                {s.agent && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {s.agent}
                  </Typography.Text>
                )}
              </Space>
              <Button
                size="small"
                type="link"
                onClick={() => {
                  setPickOpen(false)
                  navigate(`/workbench/${s.id}?pid=${projectId}&rid=${pickReq?.id}`)
                }}
              >
                继续会话
              </Button>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
