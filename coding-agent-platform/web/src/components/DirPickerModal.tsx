import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Empty, Input, Modal, Spin, Typography } from 'antd'
import {
  ArrowUpOutlined,
  FolderOutlined,
  HddOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { adminListDirs, DirListing } from '../api'

interface DirPickerModalProps {
  open: boolean
  /** 打开时的起始路径；可为空（从盘符/根列表开始）。 */
  initialPath?: string
  /**
   * 若设置，浏览范围限制在该绝对路径之下（不可上溯出 root），
   * 且 onSelect 在 relative=true 时返回相对 root 的路径。
   */
  rootPath?: string
  /** 与 rootPath 配合：选择结果转为相对路径（空串表示选中了 root 本身）。 */
  relative?: boolean
  title?: string
  onCancel: () => void
  onSelect: (path: string) => void
}

function normSlash(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function isUnderRoot(abs: string, root: string): boolean {
  const a = normSlash(abs).toLowerCase()
  const r = normSlash(root).toLowerCase()
  return a === r || a.startsWith(r + '/')
}

function toRelative(abs: string, root: string): string {
  const a = normSlash(abs)
  const r = normSlash(root)
  if (a.toLowerCase() === r.toLowerCase()) return ''
  if (a.length > r.length && a.toLowerCase().startsWith(r.toLowerCase() + '/')) {
    return a.slice(r.length + 1)
  }
  return a
}

/**
 * 网页版目录选择器：调用后端列出「运行 Janus 的这台机器」上的目录。
 * 支持 rootPath 限制（如项目 disk_path 下选日志子目录）。
 */
export default function DirPickerModal({
  open,
  initialPath,
  rootPath,
  relative,
  title,
  onCancel,
  onSelect,
}: DirPickerModalProps) {
  const { message } = AntdApp.useApp()
  const [loading, setLoading] = useState(false)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [typed, setTyped] = useState('')

  const load = async (path: string) => {
    setLoading(true)
    try {
      let target = path
      if (rootPath) {
        const root = normSlash(rootPath)
        if (!target || !isUnderRoot(target, root)) target = root
      }
      const data = await adminListDirs(target)
      if (rootPath && data.path && !isUnderRoot(data.path, rootPath)) {
        message.warning('不能离开项目目录范围')
        const fallback = await adminListDirs(normSlash(rootPath))
        setListing(fallback)
        setTyped(fallback.path)
        return
      }
      setListing(data)
      setTyped(data.path)
    } catch (e: any) {
      message.error(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const start = rootPath
      ? (initialPath && isUnderRoot(initialPath, rootPath) ? initialPath : rootPath)
      : initialPath || ''
    load(start)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rootPath])

  const current = listing?.path || ''
  const atRoots = !current && !rootPath
  const atRootFloor = !!(rootPath && current && normSlash(current).toLowerCase() === normSlash(rootPath).toLowerCase())
  const rowStyle = { textAlign: 'left' as const, justifyContent: 'flex-start', height: 'auto', padding: '6px 8px' }

  const goParent = () => {
    if (rootPath && atRootFloor) return
    if (rootPath && listing?.parent && !isUnderRoot(listing.parent, rootPath)) {
      load(rootPath)
      return
    }
    load(listing?.parent || '')
  }

  const confirm = () => {
    if (!current) return
    if (rootPath && relative) {
      onSelect(toRelative(current, rootPath))
    } else {
      onSelect(current)
    }
  }

  return (
    <Modal
      title={title || (rootPath ? '选择项目内目录' : '选择本地工程目录')}
      open={open}
      onCancel={onCancel}
      width={560}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="ok" type="primary" disabled={atRoots || loading} onClick={confirm}>
          选择此目录
        </Button>,
      ]}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        {rootPath
          ? '仅可在当前项目磁盘目录下选择子目录；确认后保存为相对路径。'
          : '浏览运行 Janus 后端的这台机器上的目录（仅列目录，不读取文件内容）。'}
      </Typography.Paragraph>

      <Input.Search
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onSearch={(v) => load(v.trim())}
        placeholder={
          rootPath ? `项目内路径，如 ${normSlash(rootPath)}/logs` : '输入或粘贴绝对路径后回车跳转'
        }
        enterButton={<ReloadOutlined />}
        style={{ marginBottom: 10 }}
      />

      <div
        style={{
          height: 300,
          overflow: 'auto',
          border: '1px solid #f0f0f0',
          borderRadius: 6,
          padding: 4,
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 110 }}>
            <Spin />
          </div>
        ) : atRoots ? (
          (listing?.roots || []).map((r) => (
            <Button key={r} type="text" block icon={<HddOutlined />} style={rowStyle} onClick={() => load(r)}>
              {r}
            </Button>
          ))
        ) : (
          <>
            <Button
              type="text"
              block
              icon={<ArrowUpOutlined />}
              style={rowStyle}
              disabled={!!rootPath && atRootFloor}
              onClick={goParent}
            >
              {rootPath && atRootFloor
                ? '已在项目根目录'
                : listing?.parent
                  ? '上级目录'
                  : '返回盘符列表'}
            </Button>
            {listing && listing.dirs.length > 0 ? (
              listing.dirs.map((d) => (
                <Button
                  key={d.path}
                  type="text"
                  block
                  icon={<FolderOutlined />}
                  style={rowStyle}
                  title={d.path}
                  onClick={() => load(d.path)}
                >
                  {d.name}
                </Button>
              ))
            ) : (
              <Empty
                description="此目录下没有子目录"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                style={{ marginTop: 60 }}
              />
            )}
          </>
        )}
      </div>

      {current && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          当前：{current}
          {rootPath && relative ? ` → 相对路径「${toRelative(current, rootPath) || '(项目根)'}」` : ''}
        </Typography.Text>
      )}
    </Modal>
  )
}
