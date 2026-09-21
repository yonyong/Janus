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
  onCancel: () => void
  onSelect: (path: string) => void
}

/**
 * 网页版目录选择器：调用后端列出「运行 Janus 的这台机器」上的目录，
 * 让浏览器环境也能正经地「选一个目录」——绕开 webkitdirectory 会枚举/上传
 * 全部文件、且拿不到绝对路径的问题。仅在桌面原生对话框不可用时使用。
 */
export default function DirPickerModal({ open, initialPath, onCancel, onSelect }: DirPickerModalProps) {
  const { message } = AntdApp.useApp()
  const [loading, setLoading] = useState(false)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [typed, setTyped] = useState('')

  const load = async (path: string) => {
    setLoading(true)
    try {
      const data = await adminListDirs(path)
      setListing(data)
      setTyped(data.path)
    } catch (e: any) {
      message.error(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load(initialPath || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const current = listing?.path || ''
  const atRoots = !current
  const rowStyle = { textAlign: 'left' as const, justifyContent: 'flex-start', height: 'auto', padding: '6px 8px' }

  return (
    <Modal
      title="选择本地工程目录"
      open={open}
      onCancel={onCancel}
      width={560}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button
          key="ok"
          type="primary"
          disabled={atRoots || loading}
          onClick={() => current && onSelect(current)}
        >
          选择此目录
        </Button>,
      ]}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        浏览运行 Janus 后端的这台机器上的目录（仅列目录，不读取文件内容）。
      </Typography.Paragraph>

      <Input.Search
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onSearch={(v) => load(v.trim())}
        placeholder="输入或粘贴绝对路径后回车跳转，如 D:/dev/my-project"
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
              onClick={() => load(listing?.parent || '')}
            >
              {listing?.parent ? '上级目录' : '返回盘符列表'}
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

      <div style={{ marginTop: 10, fontSize: 12, color: '#8f959e' }}>
        当前目录：
        <Typography.Text code style={{ fontSize: 12 }}>
          {current || '（盘符列表）'}
        </Typography.Text>
      </div>
    </Modal>
  )
}
