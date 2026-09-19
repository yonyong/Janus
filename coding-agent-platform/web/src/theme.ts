import type { ThemeConfig } from 'antd'

/** 飞书工作台风格 Design Token：飞书蓝 + 大圆角 + 浅灰底 + 轻阴影。
 *  注意：这里的色值必须与 styles.css 顶部 :root 变量保持一致（唯一来源在那边，改色先改变量）。 */
export const feishuTheme: ThemeConfig = {
  token: {
    colorPrimary: '#3370ff',
    colorInfo: '#3370ff',
    colorSuccess: '#00b42a',
    colorWarning: '#ff8800',
    colorError: '#f54a45',
    colorTextBase: '#1f2329',
    colorBgLayout: '#f5f6f7',
    colorBgContainer: '#ffffff',
    colorBorderSecondary: '#eff0f3',
    borderRadius: 8,
    borderRadiusLG: 12,
    fontSize: 14,
    lineHeight: 1.6,
    controlHeight: 34,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Inter', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif",
    boxShadowSecondary: '0 4px 16px rgba(31, 35, 41, 0.08)',
    boxShadowTertiary: '0 8px 28px rgba(31, 35, 41, 0.12)',
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      headerHeight: 56,
      headerPadding: '0 24px',
      bodyBg: '#f5f6f7',
      siderBg: '#ffffff',
      footerBg: 'transparent',
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemSelectedBg: '#f0f4ff',
      itemSelectedColor: '#3370ff',
      itemHoverBg: '#f5f7fa',
      itemBorderRadius: 8,
      itemHeight: 38,
      itemMarginInline: 8,
      iconSize: 16,
    },
    Card: {
      borderRadiusLG: 12,
      paddingLG: 20,
      headerFontSize: 15,
    },
    Button: {
      primaryShadow: 'none',
      fontWeight: 500,
      paddingInline: 16,
    },
    Table: {
      headerBg: '#fafbfc',
      headerColor: '#646a73',
      headerSplitColor: 'transparent',
      rowHoverBg: '#f7f9fc',
      borderColor: '#eff0f3',
      cellPaddingBlock: 12,
    },
    Tabs: {
      itemSelectedColor: '#3370ff',
      inkBarColor: '#3370ff',
      horizontalItemPadding: '10px 0',
      titleFontSize: 14,
    },
    Tag: {
      defaultBg: '#f2f3f5',
      defaultColor: '#646a73',
    },
    Modal: {
      borderRadiusLG: 12,
    },
    Input: {
      activeShadow: '0 0 0 2px rgba(51, 112, 255, 0.12)',
    },
    Descriptions: {
      labelBg: 'transparent',
      titleMarginBottom: 8,
    },
  },
}

export const brandPrimary = '#3370ff'

/** 品牌渐变：用于 Logo、头像、Hero 等品牌露出位置，保持视觉统一 */
export const brandGradient = 'linear-gradient(135deg, #4d7cff, #7b5cff)'
