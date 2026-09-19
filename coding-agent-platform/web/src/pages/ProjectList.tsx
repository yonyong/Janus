import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  AppstoreOutlined,
  CopyOutlined,
  DeleteOutlined,
  LinkOutlined,
  PlusOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import { useToken, useAuth } from '../auth'
import { useSearch } from '../context'
import {
  createProject,
  deleteProject,
  issueToken,
  listProjects,
  Project,
} from '../api'
import ProjectCard from '../components/ProjectCard'

const PAGE_SIZE = 9

export default function ProjectList() {
  const token = useToken()
  const { authorized } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { kw } = useSearch()
  const { message } = AntdApp.useApp()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'card' | 'table'>('card')
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(params.get('new') === '1')
  const [shareTarget, setShareTarget] = useState<Project | null>(null)
  const [shareLink, setShareLink] = useState('')
  const [form] = Form.useForm()

  const load = async () => {
    // 管理员登录时 token 为 null，但请求会自动带上 ?admin=，一样能拿到全量项目
    if (!authorized) {
      setProjects([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setProjects(await listProjects(token))
    } catch (e: any) {
      message.error(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authorized])

  useEffect(() => {
    if (params.get('new') === '1') {
      setCreateOpen(true)
      params.delete('new')
      setParams(params, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visible = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return projects
    return projects.filter(
      (p) => p.name.toLowerCase().includes(k) || p.disk_path.toLowerCase().includes(k),
    )
  }, [projects, kw])

  // 搜索词或数据变化时回到第 1 页，并防止页码越界
  useEffect(() => {
    setPage(1)
  }, [kw, projects])
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)

  const submit = async () => {
    const v = await form.validateFields()
    try {
      await createProject(token, { name: v.name.trim(), disk_path: v.disk_path.trim() })
      message.success('项目已创建')
      setCreateOpen(false)
      form.resetFields()
      load()
    } catch (e: any) {
      message.error(String(e.message || e))
    }
  }

  const genLink = async (p: Project) => {
    setShareTarget(p)
    setShareLink('')
    try {
      const r = await issueToken(token, p.id, { project_ids: [p.id] })
      setShareLink(r.link)
    } catch (e: any) {
      message.error(String(e.message || e))
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      message.success('已复制')
    } catch {
      message.warning('复制失败，请手动选择复制')
    }
  }

  const columns = [
    {
      title: '项目',
      dataIndex: 'name',
      render: (name: string, r: Project) => (
        <Space>
          <Typography.Text strong>{name}</Typography.Text>
          <Tag color="blue">#{r.id}</Tag>
        </Space>
      ),
    },
    {
      title: '本地路径',
      dataIndex: 'disk_path',
      render: (p: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {p}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      width: 220,
      render: (_: any, r: Project) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => navigate(`/projects/${r.id}`)}>
            需求
          </Button>
          <Button type="link" size="small" icon={<LinkOutlined />} onClick={() => genLink(r)}>
            分享
          </Button>
          <Popconfirm
            title="删除该项目？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              await deleteProject(token, r.id)
              message.success('已删除')
              load()
            }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto' }}>
      <Card styles={{ body: { padding: '20px 24px' } }} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <Space align="center" size={8}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                项目空间
              </Typography.Title>
              <Tag color="blue">{projects.length}</Tag>
            </Space>
            <div style={{ color: '#8f959e', fontSize: 13, marginTop: 4 }}>
              挂载本地工程目录，签发分享链接授权业务人员访问
            </div>
          </div>
          <Space>
            <Segmented
              value={view}
              onChange={(v) => setView(v as 'card' | 'table')}
              options={[
                { value: 'card', icon: <AppstoreOutlined /> },
                { value: 'table', icon: <UnorderedListOutlined /> },
              ]}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} disabled={!authorized}>
              新建项目
            </Button>
          </Space>
        </div>
      </Card>

      <Card>
        {!authorized ? (
          <Empty description="尚未登录，请在右上角账号入口用令牌或管理员口令登录" />
        ) : visible.length === 0 ? (
          <Empty description={kw ? '没有匹配的项目' : '暂无项目，点击右上角「新建项目」开始'} />
        ) : view === 'card' ? (
          <>
            <Row gutter={[16, 16]}>
              {visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE).map((p) => (
                <Col xs={24} sm={12} xl={8} xxl={6} key={p.id}>
                  <ProjectCard
                    project={p}
                    onOpen={() => navigate(`/projects/${p.id}`)}
                    onShare={() => genLink(p)}
                    onDelete={async () => {
                      await deleteProject(token, p.id)
                      message.success('已删除')
                      load()
                    }}
                  />
                </Col>
              ))}
            </Row>
            {visible.length > PAGE_SIZE && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                <Pagination
                  current={safePage}
                  pageSize={PAGE_SIZE}
                  total={visible.length}
                  onChange={setPage}
                  showSizeChanger={false}
                  showTotal={(t) => `共 ${t} 个项目`}
                />
              </div>
            )}
          </>
        ) : (
          <Table
            rowKey="id"
            dataSource={visible}
            columns={columns}
            loading={loading}
            pagination={{
              pageSize: PAGE_SIZE,
              showSizeChanger: false,
              showTotal: (t) => `共 ${t} 个项目`,
            }}
          />
        )}
      </Card>

      <Modal
        title="新建项目"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={submit}
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
            extra="Agent 将在此目录读取与修改代码，请确保路径存在"
          >
            <Input placeholder="D:/dev/my-project" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`分享链接 · ${shareTarget?.name || ''}`}
        open={!!shareTarget}
        onCancel={() => setShareTarget(null)}
        footer={[
          <Button key="c" onClick={() => setShareTarget(null)}>
            关闭
          </Button>,
          <Button key="copy" type="primary" disabled={!shareLink} onClick={() => copy(shareLink)}>
            复制链接
          </Button>,
        ]}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          该链接仅授权访问此项目，业务人员打开后即可提需求、看进度。
        </Typography.Paragraph>
        {shareLink ? (
          <Input.Search
            value={shareLink}
            readOnly
            enterButton={<Tooltip title="复制"><CopyOutlined /></Tooltip>}
            onSearch={() => copy(shareLink)}
          />
        ) : (
          <Space>
            <span className="dot-loading" />
            <Typography.Text type="secondary">签发中…</Typography.Text>
          </Space>
        )}
      </Modal>
    </div>
  )
}
