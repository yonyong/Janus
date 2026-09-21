import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'
import { feishuTheme } from './theme'

/** 可选主题。light/paper 为亮系，dark/slate 为暗系；paper 护眼、slate 深蓝墨。
 *  视觉细节（背景/卡片/边框层次）由 styles.css 的 :root[data-theme] 变量承载，
 *  这里只负责：持久化选择、写 data-theme、驱动 antd 的算法与关键 token。 */
export type ThemeMode = 'light' | 'dark' | 'paper' | 'slate'

export interface ThemeMeta {
  id: ThemeMode
  label: string
  desc: string
  dark: boolean
  /** 供切换器画的小色板（页面底色 / 卡片色 / 主色）。 */
  swatch: [string, string, string]
}

export const THEMES: ThemeMeta[] = [
  { id: 'light', label: '明亮', desc: '飞书浅色，默认', dark: false, swatch: ['#f5f6f7', '#ffffff', '#3370ff'] },
  { id: 'paper', label: '护眼', desc: '米黄暖色，久看不累', dark: false, swatch: ['#efe9db', '#fbf7ee', '#2f7d5b'] },
  { id: 'dark', label: '暗黑', desc: '深灰暗色', dark: true, swatch: ['#16181d', '#1e2128', '#5b8cff'] },
  { id: 'slate', label: '深蓝墨', desc: '午夜蓝，护眼暗色', dark: true, swatch: ['#0f172a', '#1a2338', '#5b8cff'] },
]

const STORAGE_KEY = 'janus-theme'

function readInitial(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
    if (v && THEMES.some((t) => t.id === v)) return v
  } catch {
    /* localStorage 不可用时回落默认主题 */
  }
  return 'light'
}

/** 各主题在 antd 层面的关键 token 覆盖（其余细节交给 CSS 变量）。
 *  与 styles.css 的 :root[data-theme] 变量保持一致，改色两边一起改。 */
const ANTD_TOKENS: Record<ThemeMode, Partial<NonNullable<ThemeConfig['token']>>> = {
  light: {},
  paper: {
    colorPrimary: '#2f7d5b',
    colorInfo: '#2f7d5b',
    colorBgLayout: '#e6dfcc',
    colorBgContainer: '#fdfaf3',
    colorBgElevated: '#fdfaf3',
    colorText: '#3a352c',
    colorTextBase: '#3a352c',
    colorBorder: '#ddd4c0',
    colorBorderSecondary: '#e6ddca',
  },
  dark: {
    colorPrimary: '#5b8cff',
    colorInfo: '#5b8cff',
    colorBgLayout: '#0f1116',
    colorBgContainer: '#1f232c',
    colorBgElevated: '#272c37',
    colorText: '#e6e8eb',
    colorTextBase: '#e6e8eb',
    colorBorder: '#363d49',
    colorBorderSecondary: '#2a303b',
  },
  slate: {
    colorPrimary: '#5b8cff',
    colorInfo: '#5b8cff',
    colorBgLayout: '#0a1120',
    colorBgContainer: '#1b2740',
    colorBgElevated: '#22304c',
    colorText: '#e2e8f5',
    colorTextBase: '#e2e8f5',
    colorBorder: '#30405f',
    colorBorderSecondary: '#253355',
  },
}

interface ThemeCtx {
  mode: ThemeMode
  setMode: (m: ThemeMode) => void
  isDark: boolean
}

const Ctx = createContext<ThemeCtx>({ mode: 'light', setMode: () => {}, isDark: false })

export function useThemeMode() {
  return useContext(Ctx)
}

/** 依选中主题合成 antd ThemeConfig：暗系套 darkAlgorithm，并覆盖关键 token。 */
export function buildAntdTheme(mode: ThemeMode): ThemeConfig {
  const meta = THEMES.find((t) => t.id === mode) || THEMES[0]
  const base = feishuTheme
  const darkBtn = meta.dark
    ? {
        defaultBg: 'rgba(255,255,255,0.06)',
        defaultHoverBg: 'rgba(255,255,255,0.1)',
        defaultActiveBg: 'rgba(255,255,255,0.14)',
        defaultBorderColor: 'rgba(255,255,255,0.12)',
        defaultHoverBorderColor: '#5b8cff',
        defaultActiveBorderColor: '#7aa2ff',
        defaultColor: 'rgba(230,232,235,0.82)',
        defaultHoverColor: '#5b8cff',
        defaultActiveColor: '#7aa2ff',
        defaultShadow: 'none',
        primaryShadow: 'none',
        /* 压低 darkAlgorithm 默认的近白 solid，避免误用时整块发白 */
        solidTextColor: '#e6e8eb',
      }
    : {
        primaryShadow: 'none',
      }

  const darkSolid =
    meta.dark
      ? {
          colorBgSolid: 'rgba(255,255,255,0.12)',
          colorBgSolidHover: 'rgba(255,255,255,0.18)',
          colorBgSolidActive: 'rgba(255,255,255,0.24)',
        }
      : {}

  return {
    ...base,
    algorithm: meta.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: { ...base.token, ...ANTD_TOKENS[mode], ...darkSolid },
    components: {
      ...base.components,
      Button: {
        ...(base.components?.Button || {}),
        ...darkBtn,
      },
      // 暗系下让 Layout 的头/侧/底跟随容器色，避免亮色算法遗留的白条
      Layout: {
        ...(base.components?.Layout || {}),
        ...(meta.dark
          ? {
              headerBg: ANTD_TOKENS[mode].colorBgContainer as string,
              siderBg: ANTD_TOKENS[mode].colorBgContainer as string,
              bodyBg: ANTD_TOKENS[mode].colorBgLayout as string,
              footerBg: 'transparent',
            }
          : mode === 'paper'
            ? {
                headerBg: '#fdfaf3',
                siderBg: '#fdfaf3',
                bodyBg: '#e6dfcc',
                footerBg: 'transparent',
              }
            : {}),
      },
    },
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readInitial)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* 持久化失败不影响当前会话生效 */
    }
  }, [mode])

  const meta = THEMES.find((t) => t.id === mode) || THEMES[0]
  const value = useMemo<ThemeCtx>(() => ({ mode, setMode, isDark: meta.dark }), [mode, meta.dark])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
