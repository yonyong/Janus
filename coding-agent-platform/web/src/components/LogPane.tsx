import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Empty, Select, Space, Switch, Tooltip, Typography } from 'antd'
import {
  ClearOutlined,
  ReloadOutlined,
  VerticalAlignBottomOutlined,
} from '@ant-design/icons'
import {
  DiskLogFile,
  listProjectLogFiles,
  streamProjectLogFile,
} from '../api'
import { formatLogLine } from './logFormat'

const MAX_LINES = 5000

export default function LogPane({
  token,
  pid,
  isAdmin,
  onOpenSettings,
}: {
  token: string | null
  pid: number | null
  isAdmin?: boolean
  onOpenSettings?: () => void
}) {
  const { message } = AntdApp.useApp()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [logDir, setLogDir] = useState<string | null>(null)
  const [files, setFiles] = useState<DiskLogFile[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const offsetRef = useRef(0)
  const bufRef = useRef('')
  const esRef = useRef<EventSource | null>(null)

  const appendText = useCallback((text: string) => {
    if (!text) return
    bufRef.current += text
    const parts = bufRef.current.split(/\r?\n/)
    bufRef.current = parts.pop() ?? ''
    if (!parts.length) return
    setLines((prev) => {
      const next = prev.concat(parts)
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
  }, [])

  const flushPartial = useCallback(() => {
    if (!bufRef.current) return
    const leftover = bufRef.current
    bufRef.current = ''
    setLines((prev) => {
      const next = prev.concat([leftover])
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
  }, [])

  const loadList = useCallback(async () => {
    if (pid == null) return
    setLoading(true)
    try {
      const data = await listProjectLogFiles(token, pid)
      setConfigured(data.log_dir_configured)
      setLogDir(data.log_dir)
      setFiles(data.files)
      setPath((cur) => {
        if (cur && data.files.some((f) => f.path === cur)) return cur
        return data.files[0]?.path ?? null
      })
    } catch (e: any) {
      message.error(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }, [pid, token, message])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    esRef.current?.close()
    esRef.current = null
    setLines([])
    bufRef.current = ''
    offsetRef.current = 0
    if (pid == null || !path || !configured) return

    const es = streamProjectLogFile(pid, path, token)
    esRef.current = es
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'chunk') {
          if (msg.reset) {
            setLines([])
            bufRef.current = ''
          }
          appendText(msg.content || '')
          if (typeof msg.next_offset === 'number') offsetRef.current = msg.next_offset
        } else if (msg.type === 'reset') {
          setLines([])
          bufRef.current = ''
          message.warning(msg.text || '日志已轮转，已重新加载')
        } else if (msg.type === 'error') {
          message.error(msg.text || '日志流错误')
        }
      } catch {
        /* ignore malformed */
      }
    }
    es.onerror = () => {
      // 浏览器会自动重连；保留缓冲
    }
    return () => {
      es.close()
      flushPartial()
    }
  }, [pid, path, configured, token, appendText, flushPartial, message])

  useEffect(() => {
    if (!autoScroll || !boxRef.current) return
    boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, autoScroll])

  if (pid == null) {
    return <Empty description="未关联项目" image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }

  if (configured === false) {
    return (
      <div className="disk-log-pane disk-log-empty">
        <Empty
          description={
            <span>
              管理员尚未设置项目日志目录
              {isAdmin && onOpenSettings ? (
                <>
                  ，可在
                  <Button type="link" size="small" onClick={onOpenSettings} style={{ paddingInline: 4 }}>
                    项目设置
                  </Button>
                  中指定
                </>
              ) : null}
            </span>
          }
        />
      </div>
    )
  }

  return (
    <div className="disk-log-pane">
      <div className="disk-log-toolbar">
        <Space wrap size={8} style={{ flex: 1, minWidth: 0 }}>
          <Select
            showSearch
            style={{ minWidth: 180, maxWidth: 320 }}
            placeholder={loading ? '加载中…' : '选择日志文件'}
            value={path ?? undefined}
            options={files.map((f) => ({
              value: f.path,
              label: `${f.name}（${Math.max(1, Math.round(f.size / 1024))} KB）`,
            }))}
            onChange={(v) => setPath(v)}
            optionFilterProp="label"
            notFoundContent="目录下暂无日志文件"
          />
          {logDir && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              目录：{logDir}
            </Typography.Text>
          )}
        </Space>
        <Space size={6}>
          <Tooltip title="刷新文件列表">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadList()} />
          </Tooltip>
          <Tooltip title="清屏（仅前端）">
            <Button
              size="small"
              icon={<ClearOutlined />}
              onClick={() => {
                setLines([])
                bufRef.current = ''
              }}
            />
          </Tooltip>
          <Tooltip title="自动滚到底部">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <VerticalAlignBottomOutlined />
              <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
            </span>
          </Tooltip>
        </Space>
      </div>
      <div className="disk-log-body" ref={boxRef}>
        {lines.length === 0 ? (
          <Empty
            description={path ? '暂无内容（等待写入…）' : '请选择日志文件'}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ marginTop: 48 }}
          />
        ) : (
          <pre className="disk-log-pre">
            {lines.map((ln, i) => {
              const { tone, nodes } = formatLogLine(ln)
              return (
                <div key={i} className={`disk-log-line disk-log-row-${tone}`}>
                  {nodes}
                </div>
              )
            })}
          </pre>
        )}
      </div>
    </div>
  )
}
