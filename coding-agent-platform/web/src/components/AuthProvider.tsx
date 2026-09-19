import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AuthContext, type AuthContextValue, type AuthMethod, TokenContext } from '../auth'
import {
  AUTH_EVENT,
  adoptUrlToken,
  clearUrlToken,
  describeError,
  getAdminToken,
  getStoredToken,
  readUrlToken,
  setAccessToken,
  setAdminToken,
  verifyAdmin,
  verifyToken,
} from '../api'

/**
 * 全站唯一的登录态来源。
 *
 * 设计要点：
 * - **启动引导**：分享链接的 ?token= 是一次性凭证，必须先验后用；本地凭证则乐观放行
 *   （先渲染，后台复验），避免每次都卡一个网络往返。
 * - **复验只认「凭证无效」**：401/403 才清凭证踢下线；后端不通 / 超时一律放过——
 *   否则后端抖一下就把正在干活的人踢掉，比不校验更糟。
 * - **写入收敛**：所有凭证写入都会派发 cap-auth-change，壳层与路由据此即时刷新，
 *   不再依赖 window.location.reload()。
 */
export default function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [token, setToken] = useState<string | null>(() => getStoredToken())
  const [admin, setAdmin] = useState<string | null>(() => getAdminToken())
  const [notice, setNotice] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginTab, setLoginTab] = useState<AuthMethod | null>(null)

  const sync = useCallback(() => {
    setToken(getStoredToken())
    setAdmin(getAdminToken())
  }, [])

  const revalidate = useCallback(async (method: AuthMethod, value: string) => {
    try {
      await (method === 'token' ? verifyToken(value) : verifyAdmin(value))
    } catch (e) {
      const info = describeError(e)
      if (info.status === 401 || info.status === 403) {
        if (method === 'token') setAccessToken(null)
        else setAdminToken(null)
        setNotice(
          method === 'token'
            ? '上一次使用的访问令牌已失效（被吊销或已过期），请重新登录。'
            : '上一次使用的管理员口令已失效，请重新登录。',
        )
      } else if (info.status === 400 && method === 'admin') {
        // 开放模式：后端没有启用管理员口令，本地残留的口令不该继续当作凭证
        setAdminToken(null)
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const urlToken = readUrlToken()
    if (urlToken) {
      verifyToken(urlToken)
        .then(() => {
          if (cancelled) return
          adoptUrlToken(urlToken) // 落盘 + 从地址栏抹掉，避免长期外泄
          sync()
          setReady(true)
        })
        .catch((e) => {
          if (cancelled) return
          // 无效令牌既不留地址栏也不落盘
          clearUrlToken()
          const info = describeError(e)
          setNotice(
            info.status === 401
              ? `分享链接中的${info.detail || '访问令牌无效'}，请换用有效令牌或管理员口令登录。`
              : info.message,
          )
          // 回落到本地已有凭证：别让一条过期分享链接把原本可用的人顶下线
          const stored = getStoredToken()
          const storedAdmin = getAdminToken()
          sync()
          if (stored) void revalidate('token', stored)
          else if (storedAdmin) void revalidate('admin', storedAdmin)
          setReady(true)
        })
      return () => {
        cancelled = true
      }
    }

    const stored = getStoredToken()
    const storedAdmin = getAdminToken()
    if (stored) void revalidate('token', stored)
    else if (storedAdmin) void revalidate('admin', storedAdmin)
    setReady(true)
    return () => {
      cancelled = true
    }
  }, [revalidate, sync])

  // 管理台内解锁/锁定、页面内切换账号，都要让这里即时跟上
  useEffect(() => {
    window.addEventListener(AUTH_EVENT, sync)
    return () => window.removeEventListener(AUTH_EVENT, sync)
  }, [sync])

  const authorized = !!token || !!admin

  const loginWithToken = useCallback(async (t: string) => {
    await verifyToken(t)
    setAccessToken(t)
    clearUrlToken() // 地址栏里若有旧令牌一并清掉，避免与新凭证混淆
    setNotice(null)
    setLoginOpen(false)
  }, [])

  const loginWithAdmin = useCallback(async (pwd: string) => {
    await verifyAdmin(pwd)
    setAdminToken(pwd)
    setNotice(null)
    setLoginOpen(false)
  }, [])

  const logout = useCallback(() => {
    setAccessToken(null)
    setAdminToken(null)
    setNotice(null)
    setLoginOpen(false)
    setLoginTab(null)
  }, [])

  const closeLogin = useCallback(() => {
    setLoginOpen(false)
    setLoginTab(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      token,
      admin,
      authorized,
      isAdmin: !!admin,
      notice,
      loginOpen,
      loginTab,
      loginWithToken,
      loginWithAdmin,
      logout,
      openLogin: (method?: AuthMethod) => {
        setLoginTab(method ?? null)
        setLoginOpen(true)
      },
      closeLogin,
      clearNotice: () => setNotice(null),
    }),
    [
      ready,
      token,
      admin,
      authorized,
      notice,
      loginOpen,
      loginTab,
      loginWithToken,
      loginWithAdmin,
      logout,
      closeLogin,
    ],
  )

  return (
    <AuthContext.Provider value={value}>
      <TokenContext.Provider value={token}>{children}</TokenContext.Provider>
    </AuthContext.Provider>
  )
}
