import { useMemo, useState } from 'react'
import { HashRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  App as AntdApp,
  Avatar,
  Breadcrumb,
  Button,
  ConfigProvider,
  Dropdown,
  Input,
  Layout,
  Menu,
  Space,
  Tag,
  Tooltip,
} from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  FileTextOutlined,
  FolderOutlined,
  KeyOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useAuth } from './auth'
import { SearchContext } from './context'
import { brandGradient } from './theme'
import { ThemeProvider, buildAntdTheme, useThemeMode } from './themeContext'
import ThemeSwitcher from './components/ThemeSwitcher'
import AuthProvider from './components/AuthProvider'
import AuthLoginModal from './components/AuthLoginModal'
import BrandMark from './components/BrandMark'
import SiteFooter from './components/SiteFooter'
import Dashboard from './pages/Dashboard'
import ProjectList from './pages/ProjectList'
import RequirementList from './pages/RequirementList'
import Workbench from './pages/Workbench'
import AgentList from './pages/AgentList'
import AdminConsole from './pages/AdminConsole'
import LogViewer from './pages/LogViewer'
import AuditLogs from './pages/AuditLogs'
import TokenAudit from './pages/TokenAudit'

const { Header, Sider, Content } = Layout

const TITLES: { match: (p: string) => boolean; text: string; sub: string }[] = [
  { match: (p) => p === '/', text: '工作台', sub: '概览项目、需求与 Agent 运行状况' },
  { match: (p) => p.startsWith('/projects/'), text: '需求管理', sub: '拆解需求并进入编码工作台' },
  { match: (p) => p === '/projects', text: '项目空间', sub: '管理本地工程与分享授权' },
  { match: (p) => p === '/agents', text: 'Agent 管理', sub: '注册并维护编码 Agent' },
  { match: (p) => p === '/logs', text: '实时日志', sub: '按项目实时观测 Agent 运行与文件改动' },
  { match: (p) => p === '/audit/logs', text: '操作日志', sub: '敏感操作的追责台账：谁、何时、对什么做了什么' },
  { match: (p) => p === '/audit/tokens', text: 'Token 审计', sub: '每一次 Agent 调用的入参、出参、模型与用量' },
  { match: (p) => p === '/admin', text: '管理台', sub: '项目、令牌与会话的统一管理' },
  { match: (p) => p.startsWith('/workbench'), text: '编码工作台', sub: '需求 · 设计 · 编码 · 测试' },
]

/** 仅管理员可访问的页面；非管理员给出说明，避免去打必然 401 的接口。 */
function AdminOnly({
  children,
  title = '该页面仅管理员可见',
  description = '请用管理员口令登录后再访问。',
}: {
  children: React.ReactNode
  title?: string
  description?: string
}) {
  const { isAdmin, openLogin } = useAuth()
  if (isAdmin) return <>{children}</>
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 420,
        gap: 10,
        textAlign: 'center',
      }}
    >
      <AuditOutlined style={{ fontSize: 40, color: '#c9cdd4' }} />
      <div style={{ fontSize: 15, color: '#646a73' }}>{title}</div>
      <div style={{ fontSize: 13, color: '#8f959e' }}>{description}</div>
      <Button type="primary" onClick={() => openLogin('admin')} style={{ marginTop: 6 }}>
        管理员登录
      </Button>
    </div>
  )
}

/** 未登录时的内容区占位：锁住路由，避免各页面各自抛 401 把界面刷成一片报错。 */
function LockedPlaceholder() {
  const { openLogin } = useAuth()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 420,
        gap: 10,
        textAlign: 'center',
      }}
    >
      <SafetyCertificateOutlined style={{ fontSize: 40, color: '#c9cdd4' }} />
      <div style={{ fontSize: 15, color: '#646a73' }}>请先登录后访问</div>
      <div style={{ fontSize: 13, color: '#8f959e' }}>
        令牌登录只能看到被授权的项目；管理员口令可管理全部项目。
      </div>
      <Button type="primary" onClick={() => openLogin()} style={{ marginTop: 6 }}>
        立即登录
      </Button>
    </div>
  )
}

function Shell() {
  const { ready, authorized, isAdmin, token, openLogin, logout } = useAuth()
  const { isDark } = useThemeMode()
  const location = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [kw, setKw] = useState('')

  const pathname = location.pathname
  const meta = useMemo(
    () => TITLES.find((t) => t.match(pathname)) || { text: 'Janus', sub: '' },
    [pathname],
  )
  const selected =
    pathname === '/admin'
      ? '/admin'
      : pathname === '/agents'
        ? '/agents'
        : pathname === '/logs'
          ? '/logs'
          : pathname.startsWith('/audit/')
            ? pathname
            : pathname.startsWith('/projects') || pathname.startsWith('/workbench')
              ? '/projects'
              : '/'

  // 面包屑：末级是当前页（加粗高亮），父级可点击返回；深层页面带上父级入口。
  const crumbs = useMemo<{ label: string; to?: string }[]>(() => {
    if (pathname.startsWith('/projects/'))
      return [{ label: '项目空间', to: '/projects' }, { label: '需求管理' }]
    if (pathname.startsWith('/workbench'))
      return [{ label: '项目空间', to: '/projects' }, { label: '编码工作台' }]
    return [{ label: meta.text }]
  }, [pathname, meta.text])

  // 沉浸模式：工作台自己就是完整界面，隐藏侧边菜单与顶部菜单；
  // 未登录时不进入沉浸态，否则登录入口也会一起消失，用户无从补救。
  const immersive = pathname.startsWith('/workbench') && authorized

  // 未登录时不挂载路由：各页面组件自身不会发请求，页面就不会先刷出一片 401 报错。
  const routes = authorized ? (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/projects" element={<ProjectList />} />
      <Route path="/projects/:pid" element={<RequirementList />} />
      <Route path="/workbench/:sid" element={<Workbench />} />
      <Route
        path="/agents"
        element={
          <AdminOnly
            title="Agent 管理仅管理员可见"
            description="注册与配置编码 Agent 需要管理员口令，请切换身份后再访问。"
          >
            <AgentList />
          </AdminOnly>
        }
      />
      <Route path="/logs" element={<LogViewer />} />
      <Route path="/admin" element={<AdminConsole />} />
      <Route
        path="/audit/logs"
        element={
          <AdminOnly
            title="操作日志仅管理员可见"
            description="该页面记录全平台的敏感操作明细，请用管理员口令登录后查看。"
          >
            <AuditLogs />
          </AdminOnly>
        }
      />
      <Route
        path="/audit/tokens"
        element={
          <AdminOnly
            title="Token 审计仅管理员可见"
            description="该页面记录 Agent 调用的入参、出参与用量，请用管理员口令登录后查看。"
          >
            <TokenAudit />
          </AdminOnly>
        }
      />
    </Routes>
  ) : (
    <LockedPlaceholder />
  )

  // 启动引导未完成：先给一个中性加载态，避免「未登录」弹框闪一下就消失。
  if (!ready) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        <BrandMark size={44} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8f959e', fontSize: 13 }}>
          <span className="dot-loading" />
          正在进入工作台…
        </div>
      </div>
    )
  }

  if (immersive) {
    return (
      <SearchContext.Provider value={{ kw, setKw }}>
        <div className="shell-immersive">{routes}</div>
      </SearchContext.Provider>
    )
  }

  return (
    <SearchContext.Provider value={{ kw, setKw }}>
      <Layout style={{ minHeight: '100vh' }}>
        <Sider
          width={224}
          collapsible
          collapsed={collapsed}
          trigger={null}
          theme={isDark ? 'dark' : 'light'}
          // 窄屏（<992px）自动折叠成图标栏：不依赖用户手动点「收起侧边栏」
          breakpoint="lg"
          onBreakpoint={(broken) => setCollapsed(broken)}
          style={{
            borderRight: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--sider-bg)',
          }}
        >
          <div
            className="brand"
            role="button"
            tabIndex={0}
            title="返回工作台"
            onClick={() => navigate('/')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/') } }}
            style={{ justifyContent: collapsed ? 'center' : 'flex-start', padding: collapsed ? '18px 0 16px' : '18px 18px 16px', cursor: 'pointer' }}
          >
            <BrandMark size={collapsed ? 32 : 36} />
            {!collapsed && (
              <div className="brand-text">
                <div className="brand-name">Janus</div>
                <div className="brand-sub">AI 原生开发平台</div>
              </div>
            )}
          </div>
          <div className="brand-divider" />

          <Menu
            mode="inline"
            selectedKeys={[selected]}
            style={{ borderInlineEnd: 'none', marginTop: 12, flex: 1, background: 'transparent' }}
            items={[
              { key: '/', icon: <AppstoreOutlined />, label: '工作台' },
              { key: '/projects', icon: <FolderOutlined />, label: '项目空间' },
              // 实时日志按令牌过滤项目，业务人员也该看得到自己项目的运行情况，故不限定管理员
              { key: '/logs', icon: <FileTextOutlined />, label: '实时日志' },
              // 仅管理员可见：Agent 管理、管理台、审计属于后台管理入口。
              ...(isAdmin ? [{ key: '/agents', icon: <RobotOutlined />, label: 'Agent 管理' }] : []),
              ...(isAdmin
                ? [
                    {
                      key: 'audit',
                      icon: <AuditOutlined />,
                      label: '审计',
                      children: [
                        {
                          key: '/audit/logs',
                          icon: <BarChartOutlined />,
                          label: '操作日志',
                        },
                        {
                          key: '/audit/tokens',
                          icon: <ThunderboltOutlined />,
                          label: 'Token 审计',
                        },
                      ],
                    },
                  ]
                : []),
              ...(isAdmin
                ? [{ key: '/admin', icon: <SafetyCertificateOutlined />, label: '管理台' }]
                : []),
            ]}
            // 直接落到审计页时自动展开父菜单，否则选中项藏在一个收起的组里。
            defaultOpenKeys={pathname.startsWith('/audit') ? ['audit'] : []}
            onClick={({ key }) => navigate(key)}
          />

          <div style={{ padding: 12, borderTop: '1px solid #f2f3f5' }}>
            <Button
              type="text"
              block
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((c) => !c)}
              style={{ color: '#646a73', textAlign: collapsed ? 'center' : 'left' }}
            >
              {!collapsed && '收起侧边栏'}
            </Button>
          </div>
        </Sider>

        <Layout>
          <Header
            className="app-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              borderBottom: '1px solid #eff0f3',
              position: 'sticky',
              top: 0,
              zIndex: 10,
              // 关键：antd Header 默认 line-height = 高度，多行内容会溢出顶栏；
              // 这里恢复正常行高，并从结构上改为单行面包屑，彻底消除与内容区交叉的问题。
              lineHeight: 'normal',
              background: 'var(--header-bg)',
              backdropFilter: 'blur(10px)',
              boxShadow: '0 1px 6px rgba(31, 35, 41, 0.04)',
            }}
          >
            <Breadcrumb
              style={{ flex: 'none', minWidth: 180 }}
              items={crumbs.map((c, i) => ({
                key: i,
                title: c.to ? (
                  <Link className="crumb-link" to={c.to}>
                    {c.label}
                  </Link>
                ) : (
                  <span className="crumb-current">{c.label}</span>
                ),
              }))}
            />

            <Input
              allowClear
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              prefix={<SearchOutlined style={{ color: '#8f959e' }} />}
              placeholder="搜索项目、需求…"
              className="global-search"
              style={{ maxWidth: 340 }}
              variant="borderless"
            />

            <div style={{ flex: 1 }} />

            <Space size={12}>
              <ThemeSwitcher />
              {/* 身份 Tag 只做状态展示；切换/退出收进头像下拉，避免「可点击的 Tag」这种非常规交互 */}
              <Tag
                color={isAdmin ? 'purple' : token ? 'success' : 'error'}
                icon={<KeyOutlined />}
                style={{ marginInlineEnd: 0, borderRadius: 999, paddingInline: 10 }}
              >
                {isAdmin ? '管理员' : token ? '已授权' : '未登录'}
              </Tag>
              <Tooltip title="使用提示：业务人员通过分享链接携带令牌访问，仅可见被授权项目">
                <QuestionCircleOutlined style={{ color: '#8f959e', fontSize: 16 }} />
              </Tooltip>
              <Dropdown
                trigger={['click']}
                placement="bottomRight"
                menu={{
                  items: [
                    {
                      key: 'role',
                      label: isAdmin ? '管理员 · 全部项目' : token ? '令牌登录 · 被授权项目' : '未登录',
                      disabled: true,
                    },
                    { type: 'divider' },
                    { key: 'switch', icon: <KeyOutlined />, label: '切换登录身份' },
                    { key: 'logout', icon: <SafetyCertificateOutlined />, label: '退出登录', danger: true },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'switch') openLogin()
                    if (key === 'logout') logout()
                  },
                }}
              >
                <Tooltip title="账号与登录">
                  <Avatar
                    size={30}
                    style={{ background: brandGradient, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                  >
                    JA
                  </Avatar>
                </Tooltip>
              </Dropdown>
            </Space>
          </Header>

          <Content className="app-content" style={{ padding: 24 }}>{routes}</Content>
          <SiteFooter />
        </Layout>
      </Layout>
    </SearchContext.Provider>
  )
}

function ThemedApp() {
  const { mode } = useThemeMode()
  return (
    <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
      <AntdApp>
        <AuthProvider>
          <HashRouter>
            <Shell />
          </HashRouter>
          {/* 统一登录弹框挂在壳层之外：未登录时页面加载即强制弹出，已登录时用于切换身份 */}
          <AuthLoginModal />
        </AuthProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  )
}
