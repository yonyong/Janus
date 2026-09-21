import { useEffect, useState } from 'react'
import { Alert, App as AntdApp, Button, Input, Modal, Segmented } from 'antd'
import {
  CrownOutlined,
  HistoryOutlined,
  KeyOutlined,
  LockOutlined,
  LoginOutlined,
  LogoutOutlined,
  MessageOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
} from '@ant-design/icons'
import { useAuth } from '../auth'
import { adminState, describeError } from '../api'
import BrandMark from './BrandMark'

type Tab = 'token' | 'admin'

/**
 * 统一登录弹框：令牌登录 / 管理员登录两种模式。
 *
 * 未登录时它由页面加载强制弹出且不可关闭（没有关闭按钮、点遮罩不关、Esc 不关）；
 * 已登录时同一个弹框退化成「账号与登录」，用于切换身份或退出登录。
 *
 * 视觉：宽版 920 做成「左侧品牌渐变栏 + 右侧表单面板」的登录页形态——
 * 左栏承载 Logo / 标语 / 能力要点（让宽度有存在理由），右栏表单保持紧凑定宽，
 * 输入框与提交按钮同宽对齐。窄屏时左栏收成顶部品牌条，表单独占（见 styles.css）。
 */
export default function AuthLoginModal() {
  const {
    ready,
    authorized,
    isAdmin,
    notice,
    loginOpen,
    loginTab,
    loginWithToken,
    loginWithAdmin,
    logout,
    closeLogin,
    clearNotice,
  } = useAuth()
  const { message } = AntdApp.useApp()

  const [tab, setTab] = useState<Tab>('token')
  const [tokenInput, setTokenInput] = useState('')
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adminEnabled, setAdminEnabled] = useState<boolean | null>(null)

  const open = ready && (!authorized || loginOpen)

  // 每次打开都回到干净状态，并确认后端是否启用了管理员口令
  useEffect(() => {
    if (!open) return
    setError(null)
    setTokenInput('')
    setPwd('')
    setTab(loginTab ?? 'token')
    adminState()
      .then((s) => setAdminEnabled(s.admin_enabled))
      // 连不上后端时保持可点：让提交时报出真实的连接错误，而不是误报成「未启用口令」
      .catch(() => setAdminEnabled(null))
  }, [open, loginTab])

  const submitToken = async () => {
    const t = tokenInput.trim()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    clearNotice()
    try {
      await loginWithToken(t)
      message.success('已通过访问令牌登录')
    } catch (e) {
      const info = describeError(e)
      setError(
        info.status === 401 ? `令牌无效：${info.detail || '该令牌不存在或已过期'}` : info.message,
      )
    } finally {
      setBusy(false)
    }
  }

  const submitAdmin = async () => {
    const p = pwd.trim()
    if (!p || busy) return
    setBusy(true)
    setError(null)
    clearNotice()
    try {
      await loginWithAdmin(p)
      message.success('已以管理员身份登录')
    } catch (e) {
      const info = describeError(e)
      setError(
        info.status === 401
          ? '管理员口令不正确。'
          : info.status === 400
            ? '后端未启用管理员口令（开放模式），请改用令牌登录。'
            : info.message,
      )
    } finally {
      setBusy(false)
    }
  }

  const switchTab = (v: Tab) => {
    setTab(v)
    setError(null)
    clearNotice()
  }

  const submitButton = (disabled: boolean, onSubmit: () => void) => (
    <Button
      type="primary"
      block
      size="large"
      className="auth-submit"
      icon={<LoginOutlined />}
      loading={busy}
      disabled={disabled}
      onClick={onSubmit}
    >
      登录
    </Button>
  )

  return (
    <Modal
      open={open}
      centered
      // 响应式宽度：手机上贴边自适应（留 8px 边距），≥sm 断点恢复 920 定宽（宽版两栏）
      width={{ xs: 'calc(100vw - 16px)', sm: 920 }}
      className="auth-modal"
      closable={authorized}
      maskClosable={false}
      keyboard={authorized}
      onCancel={() => {
        if (!authorized) return
        setError(null)
        closeLogin()
      }}
      footer={null}
      // 卡片本体不留内边距，左右两栏各自铺满，圆角与阴影由 container 统一给
      styles={{
        container: { padding: 0, overflow: 'hidden', borderRadius: 18 },
        body: { padding: 0 },
        mask: { background: 'rgba(15, 23, 42, 0.45)', backdropFilter: 'blur(3px)' },
      }}
    >
      <div className="auth-split">
        {/* ---- 左栏：品牌渐变（常驻，两种登录态共用） ---- */}
        <aside className="auth-brand">
          <span className="auth-brand-orb auth-brand-orb-a" />
          <span className="auth-brand-orb auth-brand-orb-b" />
          <div className="auth-brand-top">
            <span className="auth-brand-mark">
              <BrandMark size={44} />
            </span>
            <div className="auth-brand-title">
              <div className="auth-brand-name">Janus</div>
              <div className="auth-brand-slogan">让创意不止于心动，让一切皆有可能</div>
            </div>
          </div>
          <ul className="auth-brand-points">
            <li className="auth-brand-point">
              <span className="auth-brand-point-icon"><MessageOutlined /></span>
              <span className="auth-brand-point-text">
                <span className="auth-brand-point-title">对话即开发</span>
                <span className="auth-brand-point-desc">用自然语言描述改动，Agent 直接落到代码</span>
              </span>
            </li>
            <li className="auth-brand-point">
              <span className="auth-brand-point-icon"><HistoryOutlined /></span>
              <span className="auth-brand-point-text">
                <span className="auth-brand-point-title">全流程留痕</span>
                <span className="auth-brand-point-desc">需求澄清 → 用例 → 编码 → 归档，随时回看</span>
              </span>
            </li>
            <li className="auth-brand-point">
              <span className="auth-brand-point-icon"><SafetyOutlined /></span>
              <span className="auth-brand-point-text">
                <span className="auth-brand-point-title">令牌即权限</span>
                <span className="auth-brand-point-desc">只授可见项目，数据留在本机</span>
              </span>
            </li>
          </ul>
          <div className="auth-brand-foot">Janus · 本地 Coding Agent 工作台</div>
        </aside>

        {/* ---- 右栏：表单面板 ---- */}
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-panel-head">
              <div className="auth-panel-title">{authorized ? '账号与登录' : '登录 Janus'}</div>
              <div className="auth-panel-sub">
                {authorized ? '切换登录方式，或退出当前账号' : '用访问令牌或管理员口令进入工作台'}
              </div>
            </div>

            {notice && (
              <Alert
                type="warning"
                showIcon
                className="auth-notice"
                message="登录状态变化"
                description={notice}
              />
            )}

            {authorized && (
              <div className="auth-current">
                <span className="auth-current-icon">
                  {isAdmin ? <CrownOutlined /> : <KeyOutlined />}
                </span>
                <div className="auth-current-text">
                  <div className="auth-current-role">
                    当前身份：{isAdmin ? '管理员' : '访问令牌'}
                    <span className={`auth-chip ${isAdmin ? 'auth-chip-admin' : 'auth-chip-token'}`}>
                      {isAdmin ? '全部项目' : '授权项目'}
                    </span>
                  </div>
                  <div className="auth-current-desc">
                    {isAdmin
                      ? '可见全部项目，侧边栏已放开 Agent 管理与管理台。'
                      : '仅可见令牌授权的项目。'}
                  </div>
                </div>
              </div>
            )}

            <Segmented
              block
              size="large"
              className="auth-seg"
              value={tab}
              onChange={(v) => switchTab(v as Tab)}
              options={[
                { label: '令牌登录', value: 'token', icon: <KeyOutlined /> },
                { label: '管理员登录', value: 'admin', icon: <SafetyCertificateOutlined /> },
              ]}
            />

            {tab === 'token' ? (
              <div className="auth-pane">
                <Input.TextArea
                  rows={3}
                  autoFocus
                  className="auth-textarea"
                  placeholder="粘贴访问令牌"
                  value={tokenInput}
                  status={error ? 'error' : undefined}
                  onChange={(e) => {
                    setTokenInput(e.target.value)
                    if (error) setError(null)
                  }}
                  onPressEnter={(e) => {
                    if (!e.shiftKey) {
                      e.preventDefault()
                      void submitToken()
                    }
                  }}
                />
                <div className="auth-hint">
                  粘贴分享链接里 <code className="auth-code">token=</code> 后面那段即可，
                  链接形如 <code className="auth-code">http://局域网IP:5173/?token=xxx</code>
                </div>
                {error && (
                  <Alert
                    key={error}
                    type="error"
                    showIcon
                    className="auth-error"
                    message={error}
                  />
                )}
                {submitButton(!tokenInput.trim(), () => void submitToken())}
              </div>
            ) : adminEnabled === false ? (
              <Alert
                type="warning"
                showIcon
                className="auth-notice auth-notice-block"
                message="后端未启用管理员口令"
                description={
                  <>
                    当前为开放模式（<code className="auth-code">coding-agent-platform/.env</code>{' '}
                    未配置 <code className="auth-code">CAP_ADMIN_TOKEN</code>），请改用令牌登录。
                    配置口令后需重启后端。
                  </>
                }
              />
            ) : (
              <div className="auth-pane">
                <Input.Password
                  size="large"
                  autoFocus
                  className="auth-pwd"
                  prefix={<LockOutlined style={{ color: '#a2a6ad' }} />}
                  placeholder="输入管理员口令"
                  value={pwd}
                  status={error ? 'error' : undefined}
                  onChange={(e) => {
                    setPwd(e.target.value)
                    if (error) setError(null)
                  }}
                  onPressEnter={() => void submitAdmin()}
                />
                <div className="auth-hint">
                  口令配置在后端 <code className="auth-code">coding-agent-platform/.env</code> 的{' '}
                  <code className="auth-code">CAP_ADMIN_TOKEN</code>，改完需重启后端
                </div>
                {error && (
                  <Alert
                    key={error}
                    type="error"
                    showIcon
                    className="auth-error"
                    message={error}
                  />
                )}
                {submitButton(!pwd.trim(), () => void submitAdmin())}
              </div>
            )}

            {authorized && (
              <Button
                block
                danger
                icon={<LogoutOutlined />}
                className="auth-logout"
                onClick={() => {
                  logout()
                  message.success('已退出登录')
                }}
              >
                退出登录
              </Button>
            )}

            <div className="auth-foot">
              <SafetyCertificateOutlined />
              <span>凭证仅保存在本机浏览器，退出登录即可清除</span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
