import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Alert,
  Button,
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
  DeleteOutlined,
  FileAddOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  RollbackOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import {
  CHANGE_SOURCE_LABELS,
  ChangeSet,
  ChangeSetDetail,
  ChangeSetFile,
  FILE_STATUS_LABELS,
  FileChangeStatus,
  describeError,
  listChangeSets,
  changeSetDetail,
  revertChangeFile,
  revertChangeSet,
} from '../api'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

const STATUS_META: Record<FileChangeStatus, { color: string; icon: React.ReactNode }> = {
  added: { color: 'green', icon: <FileAddOutlined /> },
  modified: { color: 'blue', icon: <FileTextOutlined /> },
  removed: { color: 'red', icon: <FileExcelOutlined /> },
}

function ago(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime()
  if (Number.isNaN(t)) return iso
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return new Date(t).toLocaleString()
}

/** 把 diff 文本渲染成带行级配色的行列表。 */
function DiffBlock({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre className="chg-diff" style={{ fontFamily: MONO }}>
      {lines.map((l, i) => {
        const kind = l.startsWith('+++') || l.startsWith('---')
          ? 'meta'
          : l.startsWith('@@')
            ? 'hunk'
            : l.startsWith('+')
              ? 'add'
              : l.startsWith('-')
                ? 'del'
                : 'same'
        return (
          <div key={i} className={`chg-line chg-line-${kind}`}>
            {l || ' '}
          </div>
        )
      })}
    </pre>
  )
}

/**
 * 编码实现：Agent 对工作区的改动记录与回退。
 *
 * 记录来自「一次 agent 运行前后各拍一张工作区快照再比对」（后端 snapshots.py），
 * 所以目标项目不是 git 仓库时同样有效 —— 这是它能作为回退依据的前提。
 * 回退本身也会被记成一条新的改动记录，因此回退动作同样可追溯、可再回退。
 */
export default function ChangePane({
  token,
  pid,
  sessionId,
  refreshSignal,
  onReverted,
}: {
  token: string | null
  pid: number | null
  sessionId: number
  /** 外部（agent 跑完）自增，用于让列表静默刷新。 */
  refreshSignal?: number
  onReverted?: () => void
}) {
  const { message } = AntdApp.useApp()
  const [scope, setScope] = useState<'session' | 'project'>('session')
  const [sets, setSets] = useState<ChangeSet[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ChangeSetDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [openFile, setOpenFile] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (silent = false) => {
      if (pid === null) return
      if (!silent) setLoading(true)
      setErr('')
      try {
        const rows = await listChangeSets(token, pid, {
          session_id: scope === 'session' ? sessionId : undefined,
          limit: 50,
        })
        setSets(rows)
      } catch (e) {
        const info = describeError(e)
        if (!silent) setErr(`${info.title}${info.detail ? '：' + info.detail : ''}`)
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [pid, scope, sessionId, token],
  )

  useEffect(() => {
    void load()
  }, [load, refreshSignal])

  // 展开某条记录时才拉明细：diff 可能很大，不该在列表阶段就全量下载
  useEffect(() => {
    if (openId == null) {
      setDetail(null)
      return
    }
    let alive = true
    setDetailLoading(true)
    setOpenFile(null)
    changeSetDetail(token, openId)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null))
      .finally(() => alive && setDetailLoading(false))
    return () => {
      alive = false
    }
  }, [openId, token])

  const totals = useMemo(() => {
    const t = { added: 0, modified: 0, removed: 0, sets: sets.length }
    for (const s of sets) {
      t.added += s.added
      t.modified += s.modified
      t.removed += s.removed
    }
    return t
  }, [sets])

  const doRevert = async (csid: number, fid?: number) => {
    setBusy(true)
    try {
      const r = fid == null
        ? await revertChangeSet(token, csid)
        : await revertChangeFile(token, csid, fid)
      if (r.ok) {
        message.success(`已回退 ${r.reverted} 个文件`)
      } else {
        message.warning(`回退 ${r.reverted} 个文件，${r.skipped} 个被跳过（二进制或超大文件未存内容）`)
      }
      await load(true)
      if (openId === csid) {
        // 让明细重新拉一次，看到回退后的新状态
        setOpenId(null)
        window.setTimeout(() => setOpenId(csid), 0)
      }
      onReverted?.()
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setBusy(false)
    }
  }

  const fileRow = (f: ChangeSetFile, cs: ChangeSet) => {
    const meta = STATUS_META[f.status] || STATUS_META.modified
    const expanded = openFile === f.id
    return (
      <div className={`chg-file${expanded ? ' is-open' : ''}`} key={f.id}>
        <div
          className="chg-file-head"
          onClick={() => {
            if (!f.revertible) return
            setOpenFile(expanded ? null : f.id)
          }}
        >
          <span className={`chg-file-caret${f.revertible ? '' : ' is-hidden'}`}>
            <RightOutlined rotate={expanded ? 90 : 0} />
          </span>
          <Tag color={meta.color} bordered={false} style={{ marginInlineEnd: 0 }}>
            {FILE_STATUS_LABELS[f.status] || f.status}
          </Tag>
          <span className="chg-file-path" title={f.path}>
            {f.path}
          </span>
          <span className="chg-file-chars">
            {f.revertible ? `${f.before_chars} → ${f.after_chars} 字` : '二进制'}
          </span>
          <span className="chg-file-ops" onClick={(e) => e.stopPropagation()}>
            <Popconfirm
              title="回退这个文件？"
              description={
                <div style={{ maxWidth: 240, fontSize: 12 }}>
                  会用改动前的内容覆盖当前文件。这一步会单独记一条改动记录。
                </div>
              }
              okText="回退"
              cancelText="取消"
              onConfirm={() => doRevert(cs.id, f.id)}
              disabled={!f.revertible || busy}
            >
              <Tooltip
                title={
                  f.revertible
                    ? '把这个文件恢复成这次改动之前的内容'
                    : '二进制 / 超大文件没有保存内容，无法回退'
                }
              >
                <Button
                  size="small"
                  type="text"
                  icon={<RollbackOutlined />}
                  disabled={!f.revertible || busy}
                />
              </Tooltip>
            </Popconfirm>
          </span>
        </div>
        {expanded && f.diff && <DiffBlock text={f.diff} />}
      </div>
    )
  }

  if (pid === null) {
    return (
      <div className="chg-pane">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="拿不到项目信息，无法读取改动记录"
          style={{ marginTop: 40 }}
        />
      </div>
    )
  }

  return (
    <div className="chg-pane">
      <div className="chg-head">
        <Space size={6} wrap>
          <Tooltip title="Agent 每运行一次，就比对一次工作区快照，把这次动了哪些文件记下来">
            <Tag color="geekblue" bordered={false} style={{ marginInlineEnd: 0 }}>
              {CHANGE_SOURCE_LABELS.agent} {totals.sets}
            </Tag>
          </Tooltip>
          {totals.added > 0 && (
            <Tag color="green" bordered={false} style={{ marginInlineEnd: 0 }}>
              +{totals.added}
            </Tag>
          )}
          {totals.modified > 0 && (
            <Tag color="blue" bordered={false} style={{ marginInlineEnd: 0 }}>
              ~{totals.modified}
            </Tag>
          )}
          {totals.removed > 0 && (
            <Tag color="red" bordered={false} style={{ marginInlineEnd: 0 }}>
              −{totals.removed}
            </Tag>
          )}
        </Space>
        <Space size={6}>
          <Segmented
            size="small"
            value={scope}
            onChange={(v) => setScope(v as 'session' | 'project')}
            options={[
              { value: 'session', label: '本会话' },
              { value: 'project', label: '全项目' },
            ]}
          />
          <Tooltip title="刷新改动记录">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined spin={loading} />}
              onClick={() => void load()}
            />
          </Tooltip>
        </Space>
      </div>

      {err && <Alert type="error" showIcon message={err} style={{ margin: '0 10px 8px' }} />}

      <div className="chg-list">
        {loading && sets.length === 0 ? (
          <Skeleton active paragraph={{ rows: 4 }} style={{ padding: 12 }} />
        ) : sets.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              scope === 'session'
                ? '本会话还没有改动：在右侧让 Agent 改一次代码，这里就会出现记录'
                : '项目下还没有改动记录'
            }
            style={{ marginTop: 40 }}
          />
        ) : (
          sets.map((cs) => {
            const expanded = openId === cs.id
            const isRevert = cs.source === 'revert'
            return (
              <div className={`chg-set${expanded ? ' is-open' : ''}`} key={cs.id}>
                <div
                  className="chg-set-head"
                  onClick={() => setOpenId(expanded ? null : cs.id)}
                >
                  <span className="chg-set-caret">
                    <RightOutlined rotate={expanded ? 90 : 0} />
                  </span>
                  <div className="chg-set-main">
                    <div className="chg-set-top">
                      <Tag
                        color={isRevert ? 'orange' : 'geekblue'}
                        bordered={false}
                        icon={isRevert ? <HistoryOutlined /> : undefined}
                        style={{ marginInlineEnd: 0 }}
                      >
                        {CHANGE_SOURCE_LABELS[cs.source] || cs.source}
                      </Tag>
                      <span className="chg-set-time">{ago(cs.created_at)}</span>
                    </div>
                    <div className="chg-set-note">{cs.note || `改动记录 #${cs.id}`}</div>
                    <div className="chg-set-stats">
                      <span className="chg-stat chg-stat-add">
                        <PlusOutlined /> {cs.added}
                      </span>
                      <span className="chg-stat chg-stat-mod">
                        <FileTextOutlined /> {cs.modified}
                      </span>
                      <span className="chg-stat chg-stat-del">
                        <DeleteOutlined /> {cs.removed}
                      </span>
                      <span className="chg-set-files">{cs.file_count} 个文件</span>
                      {cs.truncated && (
                        <Tooltip title="工作区文件过多，这次快照被截断，记录可能不完整">
                          <span className="chg-trunc">
                            <WarningOutlined /> 已截断
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>

                {expanded && (
                  <div className="chg-set-body">
                    {detailLoading ? (
                      <Skeleton active paragraph={{ rows: 3 }} />
                    ) : detail && detail.id === cs.id ? (
                      <>
                        <div className="chg-set-toolbar">
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            点文件名看逐行 diff
                          </Typography.Text>
                          <Popconfirm
                            title="回退整条改动记录？"
                            description={
                              <div style={{ maxWidth: 280, fontSize: 12 }}>
                                这条记录里的 {detail.file_count} 个文件都会恢复成改动之前的样子
                                （新增的会被删除）。回退本身也会记成一条新记录，所以还能再退回来。
                              </div>
                            }
                            okText="全部回退"
                            cancelText="取消"
                            onConfirm={() => doRevert(cs.id)}
                            disabled={busy}
                          >
                            <Button
                              size="small"
                              danger
                              icon={<RollbackOutlined />}
                              loading={busy}
                              disabled={!detail.file_count}
                            >
                              回退整条
                            </Button>
                          </Popconfirm>
                        </div>
                        {detail.files.length === 0 ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            这条记录里没有文件
                          </Typography.Text>
                        ) : (
                          detail.files.map((f) => fileRow(f, detail))
                        )}
                      </>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        明细读取失败
                      </Typography.Text>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
