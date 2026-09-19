import { useEffect, useState } from 'react'
import { Alert, App as AntdApp, Button, Input, Modal, Segmented } from 'antd'
import {
  CrownOutlined,
  KeyOutlined,
  LinkOutlined,
  LockOutlined,
  LoginOutlined,
  LogoutOutlined,
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
 * 视觉上用品牌渐变头 + 白卡主体：头部的渐变与首页 Hero、侧栏 Logo 同一套色，
 * 主体只留「模式切换 → 输入 → 提交」三块，把原先的大段说明收进浅色提示条。
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
      // 响应式宽度：手机上贴边自适应（留 8px 边距），≥sm 断点恢复 460 定宽
      width={{ xs: 'calc(100vw - 16px)', sm: 460 }}
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
      // 自绘头部：把 antd 默认的标题栏内边距 / 边框清零，让渐变整幅铺满卡片顶部。
      styles={{
        container: { padding: 0, overflow: 'hidden', borderRadius: 16 },
        header: {
          padding: 0,
          margin: 0,
          background: 'transparent',
          borderBottom: 'none',
          borderRadius: 0,
        },
        title: { padding: 0, color: 'inherit', fontSize: 'inherit', fontWeight: 400, lineHeight: 'normal' },
        body: { padding: 0 },
        close: { top: 16, insetInlineEnd: 12, color: 'rgba(255,255,255,0.92)', zIndex: 4 },
        mask: { background: 'rgba(15, 23, 42, 0.45)', backdropFilter: 'blur(3px)' },
      }}
      title={
        <div className="auth-head">
          <span className="auth-head-orb auth-head-orb-a" />
          <span className="auth-head-orb auth-head-orb-b" />
          <span className="auth-head-mark">
            <BrandMark size={34} />
          </span>
          <div className="auth-head-text">
            <div className="auth-head-title-row">
              <div className="auth-head-title">{authorized ? '账号与登录' : '登录 Janus'}</div>
              {!authorized && (
                <div className="auth-head-slogan"><span className="auth-head-slogan-brand">Janus</span> - 让创意不止于心动，让一切皆有可能</div>
              )}
            </div>
            {authorized && (
              <div className="auth-head-sub">切换登录方式，或退出当前账号</div>
            )}
          </div>
        </div>
      }
    >
      <div className="auth-body">
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

        {notice && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16, borderRadius: 10 }}
            message="登录状态变化"
            description={notice}
          />
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
            <div className="auth-tip">
              <LinkOutlined className="auth-tip-icon" />
              <div>
                令牌由项目管理者签发，粘贴分享链接里 <code className="auth-code">token=</code>{' '}
                后面那段即可，链接形如{' '}
                <code className="auth-code">http://host:8000/?token=xxx</code>。
              </div>
            </div>
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
            style={{ marginTop: 16, borderRadius: 10 }}
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
            <div className="auth-tip">
              <SafetyOutlined className="auth-tip-icon" />
              <div>
                口令配置在 <code className="auth-code">coding-agent-platform/.env</code> 的{' '}
                <code className="auth-code">CAP_ADMIN_TOKEN</code>；登录后可见全部项目。
              </div>
            </div>
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
          凭证仅保存在本机浏览器，退出登录即可清除
        </div>
      </div>
    </Modal>
  )
}
