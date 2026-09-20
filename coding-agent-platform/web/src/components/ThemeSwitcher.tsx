import { Dropdown, Tooltip } from 'antd'
import { BgColorsOutlined, CheckOutlined } from '@ant-design/icons'
import { THEMES, useThemeMode } from '../themeContext'

/** 主题切换器：点击弹出主题清单（带小色板预览），选中项打勾。
 *  compact 时只显示图标按钮（工作台顶条用），否则同样是图标（顶栏用）。 */
export default function ThemeSwitcher({ size = 16 }: { size?: number }) {
  const { mode, setMode } = useThemeMode()

  const items = THEMES.map((t) => ({
    key: t.id,
    label: (
      <div className="theme-opt">
        <span className="theme-opt-swatch" aria-hidden>
          <i style={{ background: t.swatch[0] }} />
          <i style={{ background: t.swatch[1] }} />
          <i style={{ background: t.swatch[2] }} />
        </span>
        <span className="theme-opt-text">
          <span className="theme-opt-name">{t.label}</span>
          <span className="theme-opt-desc">{t.desc}</span>
        </span>
        {mode === t.id && <CheckOutlined className="theme-opt-check" />}
      </div>
    ),
  }))

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{ items, selectedKeys: [mode], onClick: ({ key }) => setMode(key as typeof mode) }}
    >
      <Tooltip title="切换主题">
        <button type="button" className="theme-switch-btn" aria-label="切换主题">
          <BgColorsOutlined style={{ fontSize: size }} />
        </button>
      </Tooltip>
    </Dropdown>
  )
}
