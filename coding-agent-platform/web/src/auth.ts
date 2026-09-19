import { createContext, useContext } from 'react'

/** 访问令牌从分享链接的 ?token= 透传，整站通过此 Context 读取。 */
export const TokenContext = createContext<string | null>(null)

export const useToken = () => useContext(TokenContext)

// ---------------- 统一认证 ----------------
// 全站只有一套登录态：令牌（业务授权，只可见被授权项目）与管理员口令（全量项目）
// 是同一入口下的两种登录方式，任一有效即视为已登录。

/** 登录方式：令牌登录 / 管理员登录。 */
export type AuthMethod = 'token' | 'admin'

export interface AuthState {
  /** 启动引导是否完成。未完成前不得判定「未登录」，否则会先闪一下登录弹框。 */
  ready: boolean
  /** 当前访问令牌；未持有为 null（纯管理员登录时就是 null）。 */
  token: string | null
  /** 当前管理员口令；未以管理员登录为 null。管理台用它判断是否已解锁。 */
  admin: string | null
  /** 令牌或管理员口令任一有效即为 true；路由渲染与接口请求都以它为准。 */
  authorized: boolean
  /** 是否处于管理员态：可见全部项目，侧边栏放开 Agent 管理 / 管理台入口。 */
  isAdmin: boolean
  /** 需要向用户交代的一次性提示，例如分享链接里的令牌已失效。 */
  notice: string | null
  /** 用户是否主动打开了登录弹框（未登录时它本来就是强制弹出的）。 */
  loginOpen: boolean
  /** 弹框打开时默认落在哪个登录方式；null 表示用默认的令牌登录。 */
  loginTab: AuthMethod | null
}

export interface AuthActions {
  /** 校验并采用访问令牌；不通过时抛出 ApiError，由弹框展示。 */
  loginWithToken: (token: string) => Promise<void>
  /** 校验并采用管理员口令；不通过时抛出 ApiError，由弹框展示。 */
  loginWithAdmin: (password: string) => Promise<void>
  /** 退出登录：两种凭证一并清除，并回到登录弹框。 */
  logout: () => void
  /** 打开登录弹框；可指定默认落在哪个登录方式（如管理台直接落「管理员登录」）。 */
  openLogin: (method?: AuthMethod) => void
  closeLogin: () => void
  /** 消费掉一次性提示，避免同一句话反复弹。 */
  clearNotice: () => void
}

export type AuthContextValue = AuthState & AuthActions

export const AuthContext = createContext<AuthContextValue | null>(null)

/** 读取统一登录态。必须在 AuthProvider 内使用。 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
