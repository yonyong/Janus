import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Avatar,
  Button,
  Card,
  Col,
  Empty,
  List,
  Row,
  Skeleton,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd'
import {
  FolderOutlined,
  LinkOutlined,
  PlusOutlined,
  RobotOutlined,
  RocketOutlined,
} from '@ant-design/icons'
import { useToken, useAuth } from '../auth'
import { useSearch } from '../context'
import { listAgents, listProjects, listRequirements, Agent, Project } from '../api'
import ProjectCard from '../components/ProjectCard'

const greet = () => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function HeroStat({ title, value, loading }: { title: string; value: number; loading?: boolean }) {
  return (
    <div className="hero-stat">
      {loading ? (
        <Skeleton.Button active style={{ width: 48, height: 24 }} />
      ) : (
        <Statistic
          title={<span style={{ color: 'rgba(255,255,255,0.82)', fontSize: 12 }}>{title}</span>}
          value={value}
          valueStyle={{ color: '#fff', fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}
        />
      )}
    </div>
  )
}

function QuickEntry({ icon, title, desc, onClick }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <div className="quick-entry" onClick={onClick}>
      <Avatar shape="square" size={40} icon={icon} style={{ background: '#f0f4ff', color: '#3370ff' }} />
      <div style={{ marginTop: 10, fontSize: 13, fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 11, color: '#8f959e', marginTop: 2 }}>{desc}</div>
    </div>
  )
}

export default function Dashboard() {
  const token = useToken()
  const { authorized, isAdmin } = useAuth()
  const navigate = useNavigate()
  const { kw } = useSearch()
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [reqCount, setReqCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      try {
        // 管理员登录时 token 为 null，但请求会自动带上 ?admin=，一样能拿到全量项目
        const [ps, as] = await Promise.all([listProjects(token), listAgents().catch(() => [])])
        if (!active) return
        setProjects(ps)
        setAgents(as)
        const counts = await Promise.all(ps.slice(0, 20).map((p) => listRequirements(token, p.id).then((r) => r.length).catch(() => 0)))
        if (active) setReqCount(counts.reduce((a, b) => a + b, 0))
      } catch (e: any) {
        if (active) setErr(String(e.message || e))
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const visible = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return projects
    return projects.filter(
      (p) => p.name.toLowerCase().includes(k) || p.disk_path.toLowerCase().includes(k),
    )
  }, [projects, kw])

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto' }}>
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ fontSize: 13, opacity: 0.85 }}>{greet()}，欢迎回到 Janus</div>
          <div style={{ marginTop: 10, fontSize: 24, fontWeight: 700, letterSpacing: 0.5 }}>
            <span className="hero-slogan-brand">Janus</span> - 让创意不止于心动，让一切皆有可能
          </div>
          <div style={{ fontSize: 14, opacity: 0.9, marginTop: 8 }}>
            把脑海中的念头，从一句话需求变成可运行的代码与产品。
          </div>
        </div>
        <Space size={12} style={{ position: 'relative', zIndex: 1 }}>
          <HeroStat title="可见项目" value={projects.length} loading={loading} />
          <HeroStat title="需求" value={reqCount} loading={loading} />
          <HeroStat title="已注册 Agent" value={agents.length} loading={loading} />
        </Space>
      </div>

      {!authorized && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16, borderRadius: 10 }}
          message="尚未登录"
          description="请通过项目管理者签发的分享链接进入，或在右上角账号入口用令牌 / 管理员口令登录。"
        />
      )}
      {err && <Alert type="error" showIcon style={{ marginTop: 16 }} message={err} />}

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} lg={16}>
          <Card title="快捷入口" styles={{ header: { borderBottom: '1px solid #f2f3f5' } }}>
            <div className="quick-grid">
              <QuickEntry
                icon={<FolderOutlined />}
                title="项目空间"
                desc={isAdmin ? '管理工程与授权' : '查看已授权工程'}
                onClick={() => navigate('/projects')}
              />
              {isAdmin && (
                <>
                  <QuickEntry icon={<RobotOutlined />} title="Agent 管理" desc="注册编码 Agent" onClick={() => navigate('/agents')} />
                  <QuickEntry icon={<PlusOutlined />} title="新建项目" desc="挂载本地工程" onClick={() => navigate('/projects?new=1')} />
                  <QuickEntry icon={<LinkOutlined />} title="分享与授权" desc="签发访问链接" onClick={() => navigate('/projects')} />
                </>
              )}
            </div>
          </Card>

          <Card
            title="我的项目"
            style={{ marginTop: 16 }}
            extra={
              <Button type="link" size="small" onClick={() => navigate('/projects')} style={{ paddingInline: 0 }}>
                全部项目（{projects.length}）
              </Button>
            }
          >
            {loading ? (
              <Row gutter={[16, 16]}>
                {[0, 1, 2].map((i) => (
                  <Col xs={24} sm={12} xl={8} key={i}>
                    <Skeleton active paragraph={{ rows: 2 }} style={{ padding: 16, border: '1px solid #f2f3f5', borderRadius: 12 }} />
                  </Col>
                ))}
              </Row>
            ) : visible.length === 0 ? (
              <Empty description={kw ? '没有匹配的项目' : authorized ? '暂无可见项目，先在「项目空间」添加' : '尚未登录'} />
            ) : (
              <Row gutter={[16, 16]}>
                {visible.slice(0, 6).map((p) => (
                  <Col xs={24} sm={12} xl={8} key={p.id}>
                    <ProjectCard project={p} onOpen={() => navigate(`/projects/${p.id}`)} />
                  </Col>
                ))}
              </Row>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card title="Agent 运行状况" style={{ marginTop: 16 }} className="lg-mt-0">
            {agents.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 Agent" />
            ) : (
              <List
                dataSource={agents}
                renderItem={(a) => (
                  <List.Item>
                    <List.Item.Meta
                      avatar={
                        <Avatar shape="square" size={34} style={{ background: '#f0f4ff', color: '#3370ff' }}>
                          <RobotOutlined />
                        </Avatar>
                      }
                      title={<span style={{ fontSize: 13 }}>{a.name}</span>}
                      description={<Tag color="blue" style={{ marginTop: 2 }}>{a.type}</Tag>}
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>

          <Card title="接入状态" style={{ marginTop: 16 }}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography.Text type="secondary">登录方式</Typography.Text>
                <Tag color={authorized ? 'success' : 'error'}>
                  {isAdmin ? '管理员口令' : authorized ? '访问令牌' : '未登录'}
                </Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography.Text type="secondary">可见项目</Typography.Text>
                <Typography.Text strong>{projects.length}</Typography.Text>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography.Text type="secondary">后端地址</Typography.Text>
                <Typography.Text code>:8000</Typography.Text>
              </div>
            </Space>
            <div style={{ marginTop: 14, padding: 12, background: '#f7f9fc', borderRadius: 10 }}>
              <Space align="start">
                <RocketOutlined style={{ color: '#3370ff', marginTop: 3 }} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  在项目详情里点「进入工作台」，即可与 Agent 对话并实时查看编码与测试结果。
                </Typography.Text>
              </Space>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
