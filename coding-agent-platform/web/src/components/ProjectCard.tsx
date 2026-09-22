import { useId } from 'react'
import { Button, Card, Popconfirm, Space, Tooltip, Typography } from 'antd'
import { DeleteOutlined, FolderOpenOutlined, LinkOutlined, RightOutlined, SettingOutlined } from '@ant-design/icons'
import type { Project } from '../api'

type FolderVariant = 'windows' | 'mac' | 'brand'

const FOLDER_VARIANTS: FolderVariant[] = ['windows', 'mac', 'brand']

/** 三种文件夹造型按项目 id 交错：Windows 黄 → Mac 蓝 → 平台渐变紫，再循环。 */
const variantOf = (id: number): FolderVariant => FOLDER_VARIANTS[id % 3]

/**
 * 自绘双色文件夹图标，三种风格共用同一几何形：
 * - windows：经典 Win11 黄
 * - mac：macOS 蓝
 * - brand：平台蓝紫渐变
 * 后片（文件夹背板）一律用前片同色降饱和/降透明，呈现立体层次。
 */
function FolderGlyph({ variant, size = 32 }: { variant: FolderVariant; size?: number }) {
  const uid = useId()
  const gid = `fg-${variant}-${uid.replace(/[:]/g, '')}`
  const skins: Record<FolderVariant, { back: string; frontFrom: string; frontTo: string }> = {
    windows: { back: '#ffd968', frontFrom: '#ffcf45', frontTo: '#f5ac1f' },
    mac: { back: '#85c8f9', frontFrom: '#6ab5f2', frontTo: '#3f8ddd' },
    brand: { back: '#9aa4ff', frontFrom: '#4d7cff', frontTo: '#7b5cff' },
  }
  const s = skins[variant]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="12" y1="7" x2="12" y2="19" gradientUnits="userSpaceOnUse">
          <stop stopColor={s.frontFrom} />
          <stop offset="1" stopColor={s.frontTo} />
        </linearGradient>
      </defs>
      <path
        d="M3 6.4C3 5.63 3.63 5 4.4 5h4.42c.42 0 .82.17 1.11.47L11.5 7H19.6c.77 0 1.4.63 1.4 1.4V9.4H3V6.4z"
        fill={s.back}
      />
      <path
        d="M3 9.6h18v7.9c0 .77-.63 1.4-1.4 1.4H4.4A1.4 1.4 0 0 1 3 17.5V9.6z"
        fill={`url(#${gid})`}
      />
    </svg>
  )
}

/**
 * 项目卡片：三种系统风格文件夹图标交错（Windows 黄 / Mac 蓝 / 平台渐变紫），
 * 卡片本体保持素净，让图标成为唯一的视觉焦点。
 */
export default function ProjectCard({
  project,
  onOpen,
  onShare,
  onSettings,
  onDelete,
}: {
  project: Project
  onOpen: () => void
  onShare?: () => void
  onSettings?: () => void
  onDelete?: () => void
}) {
  return (
    <Card
      className="app-tile"
      styles={{ body: { padding: '18px 18px 10px' } }}
      onClick={onOpen}
      style={{ cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', gap: 13, alignItems: 'center' }}>
        <div className="tile-icon" aria-hidden>
          <FolderGlyph variant={variantOf(project.id)} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text
            style={{ fontSize: 15, fontWeight: 500, letterSpacing: 0.2, color: '#1f2329', display: 'block', lineHeight: 1.4 }}
            ellipsis={{ tooltip: project.name }}
          >
            {project.name}
          </Typography.Text>
          <Tooltip title={project.disk_path}>
            <div
              className="tile-path"
              style={{
                fontSize: 12,
                color: '#8b919d',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 6,
                letterSpacing: 0.1,
              }}
            >
              {project.disk_path}
            </div>
          </Tooltip>
        </div>
      </div>

      <div
        className="tile-footer"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 15,
          paddingTop: 8,
          borderTop: '1px solid rgba(31, 35, 41, 0.055)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Space size={2}>
          {onSettings && (
            <Button size="small" type="text" icon={<SettingOutlined />} onClick={onSettings} className="tile-ghost-btn">
              设置
            </Button>
          )}
          {onShare && (
            <Button size="small" type="text" icon={<LinkOutlined />} onClick={onShare} className="tile-ghost-btn">
              分享
            </Button>
          )}
          {onDelete && (
            <Popconfirm title="删除该项目？" description="项目下的需求与会话将一并移除" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={onDelete}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} className="tile-ghost-btn" />
            </Popconfirm>
          )}
        </Space>
        <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={onOpen} className="tile-ghost-btn tile-open-btn">
          需求 <RightOutlined style={{ fontSize: 10 }} />
        </Button>
      </div>
    </Card>
  )
}
