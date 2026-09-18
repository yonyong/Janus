import { createContext, useContext } from 'react'

/** 访问令牌从分享链接的 ?token= 透传，整站通过此 Context 读取。 */
export const TokenContext = createContext<string | null>(null)

export const useToken = () => useContext(TokenContext)
