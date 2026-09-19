import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Alert,
  Button,
  Drawer,
  Empty,
  Popconfirm,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ClockCircleOutlined,
  HistoryOutlined,
  ReloadOutlined,
  RollbackOutlined,
} from '@ant-design/icons'
import {
  DOC_SOURCE_LABELS,
  DocSource,
  Requirement,
  RequirementVersion,
  RequirementVersionDetail,
  describeError,
  getRequirementVersion,
  listRequirementVersions,
  restoreRequirementVersion,
} from '../api'
import RichText from './RichText'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

const SOURCE_COLOR: Record<DocSource, string> = {
  create: 'default',
  manual: 'blue',
  ai: 'purple',
  revert: 'orange',
}

type DiffLine = { type: 'same' | 'add' | 'del'; text: string }

/**
 * 行级 diff（LCS）。需求文档量级很小（几十到几百行），直接 O(n*m) 即可，
 * 不值得为它引一个 diff 依赖。超过上限就放弃对比、退回并排展示。
 */
function diffLines(before: string, after: string, cap = 600): DiffLine[] | null {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length > cap || b.length > cap) return null
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] })
    } else {
      out.push({ type: 'add', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] })
  while (j < b.length) out.push({ type: 'add', text: b[j++] })
  return out
}

function ago(iso: string | null): string {
  if (!iso) return ''
  // 后端存的是 UTC（sqlite datetime('now')），补上 Z 再让浏览器按本地时区显示
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime()
  if (Number.isNaN(t)) return iso
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(t).toLocaleDateString()
}

/**
 * 需求文档的历史版本：查看、与当前对比、回退。
 *
 * 回退是「把旧内容当成一次新的修改写回去」，所以回退本身也会变成历史里的一版，
 * 不会把中间的过程抹掉 —— 界面上也照实这么说，免得用户以为回退不可逆。
 */
export default function VersionHistoryDrawer({
  token,
  requirement,
  open,
  onClose,
  onRestored,
}: {
  token: string | null
  requirement: Requirement | null
  open: boolean
  onClose: () => void
  onRestored: (r: Requirement) => void
}) {
  const { message } = AntdApp.useApp()
  const [versions, setVersions] = useState<RequirementVersion[]>([])
  const [loading, setLoading] = useState(false)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [detail, setDetail] = useState<RequirementVersionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [view, setView] = useState<'preview' | 'diff'>('preview')
  const [restoring, setRestoring] = useState(false)
  const [err, setErr] = useState('')

  const rid = requirement?.id ?? null

  const load = useCallback(async () => {
    if (rid == null) return
    setLoading(true)
    setErr('')
    try {
      const vs = await listRequirementVersions(token, rid)
      setVersions(vs)
      setActiveId((cur) => (cur != null && vs.some((v) => v.id === cur) ? cur : vs[0]?.id ?? null))
    } catch (e) {
      const info = describeError(e)
      setErr(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setLoading(false)
    }
  }, [rid, token])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 打开时默认选中「当前版本」，让用户一眼看到自己现在在哪一版
  useEffect(() => {
    if (!open || loading || activeId != null) return
    const cur = versions.find((v) => v.current)
    if (cur) setActiveId(cur.id)
  }, [open, loading, versions, activeId])

  useEffect(() => {
    if (!open || rid == null || activeId == null) {
      setDetail(null)
      return
    }
    let alive = true
    setDetailLoading(true)
    getRequirementVersion(token, rid, activeId)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null))
      .finally(() => alive && setDetailLoading(false))
    return () => {
      alive = false
    }
  }, [open, rid, activeId, token])

  const active = versions.find((v) => v.id === activeId) || null

  const lines = useMemo(() => {
    if (view !== 'diff' || !detail) return null
    return diffLines(detail.description || '', requirement?.description || '')
  }, [view, detail, requirement?.description])

  const changed = useMemo(
    () => (lines ? lines.filter((l) => l.type !== 'same').length : 0),
    [lines],
  )

  const doRestore = async () => {
    if (!active || rid == null || restoring) return
    setRestoring(true)
    try {
      const r = await restoreRequirementVersion(token, rid, active.id)
      onRestored(r)
      message.success(`已回退到${ago(active.created_at) ? '「' + ago(active.created_at) + '」的版本' : '该版本'}`)
      await load()
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Drawer
      className="vh-drawer"
      title={
        <Space size={8}>
          <HistoryOutlined />
          <span>需求文档历史</span>
          {versions.length > 0 && (
            <Tag style={{ marginInlineEnd: 0 }}>{versions.length} 个版本</Tag>
          )}
        </Space>
      }
      width={720}
      open={open}
      onClose={onClose}
      extra={
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      }
    >
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}

      <div className="vh-body">
        <div className="vh-list">
          {loading && versions.length === 0 ? (
            <Skeleton active paragraph={{ rows: 5 }} />
          ) : versions.length === 0 ? (
            <Empty description="还没有历史版本" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            versions.map((v) => (
              <button
                type="button"
                key={v.id}
                className={`vh-item${v.id === activeId ? ' is-active' : ''}${v.current ? ' is-current' : ''}`}
                onClick={() => setActiveId(v.id)}
              >
                <div className="vh-item-top">
                  <Tag color={SOURCE_COLOR[v.source]} style={{ marginInlineEnd: 0 }}>
                    {DOC_SOURCE_LABELS[v.source] || v.source}
                  </Tag>
                  {v.current && (
                    <Tag color="green" style={{ marginInlineEnd: 0 }}>
                      当前
                    </Tag>
                  )}
                  <span className="vh-item-time">
                    <ClockCircleOutlined /> {ago(v.created_at)}
                  </span>
                </div>
                <div className="vh-item-title">{v.title || '（无标题）'}</div>
                <div className="vh-item-meta">
                  {v.chars} 字 · #{v.id}
                  {v.note ? ` · ${v.note}` : ''}
                </div>
                <div className="vh-item-preview">{v.preview || '（空白文档）'}</div>
              </button>
            ))
          )}
        </div>

        <div className="vh-detail">
          {activeId == null ? (
            <Empty description="选择左侧任一版本查看" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <>
              <div className="vh-detail-head">
                <Segmented
                  size="small"
                  value={view}
                  onChange={(v) => setView(v as 'preview' | 'diff')}
                  options={[
                    { value: 'preview', label: '内容' },
                    { value: 'diff', label: '与当前对比' },
                  ]}
                />
                <Popconfirm
                  title="回退到这一版？"
                  description={
                    <div style={{ maxWidth: 260, fontSize: 12 }}>
                      当前文档内容会被覆盖。回退本身也会记为一个新版本，
                      所以这一步不会丢掉任何历史，随时可以再退回来。
                    </div>
                  }
                  okText="回退"
                  cancelText="取消"
                  onConfirm={doRestore}
                  disabled={!active || active.current}
                >
                  <Tooltip title={active?.current ? '已经是当前版本' : '把文档恢复成这一版'}>
                    <Button
                      size="small"
                      icon={<RollbackOutlined />}
                      loading={restoring}
                      disabled={!active || active.current}
                    >
                      回退到此版本
                    </Button>
                  </Tooltip>
                </Popconfirm>
              </div>

              {detailLoading ? (
                <Skeleton active paragraph={{ rows: 8 }} />
              ) : !detail ? (
                <Empty description="这一版读不出来" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : view === 'preview' ? (
                <div className="vh-doc">
                  <div className="vh-doc-title">{detail.title}</div>
                  {detail.description.trim() ? (
                    <RichText text={detail.description} />
                  ) : (
                    <Typography.Text type="secondary">（空白文档）</Typography.Text>
                  )}
                </div>
              ) : lines === null ? (
                <Alert
                  type="info"
                  showIcon
                  message="文档过长，不在这里做行级对比"
                  description={<span style={{ fontSize: 12 }}>可切到「内容」逐版查看。</span>}
                />
              ) : changed === 0 ? (
                <Alert
                  type="success"
                  showIcon
                  message="这一版与当前文档完全一致"
                  description={
                    <span style={{ fontSize: 12 }}>
                      多见于回退之后：内容相同，但历史里保留了两条记录。
                    </span>
                  }
                />
              ) : (
                <div className="vh-diff">
                  <div className="vh-diff-legend">
                    <span className="vh-del">− 这一版有、当前没有</span>
                    <span className="vh-add">+ 当前有、这一版没有</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      共 {changed} 行差异
                    </Typography.Text>
                  </div>
                  <pre className="vh-diff-body" style={{ fontFamily: MONO }}>
                    {lines.map((l, i) => (
                      <div key={i} className={`vh-line vh-line-${l.type}`}>
                        <span className="vh-line-sign">
                          {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                        </span>
                        {l.text || ' '}
                      </div>
                    ))}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Drawer>
  )
}
