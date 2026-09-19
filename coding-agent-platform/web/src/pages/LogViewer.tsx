import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App as AntdApp, Button, Card, Empty, Input, Select, Space, Switch, Tag, Tooltip } from 'antd'
import {
  CaretRightOutlined,
  ClearOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  PauseOutlined,
  VerticalAlignBottomOutlined,
} from '@ant-design/icons'
import { useToken } from '../auth'
import {
  LOG_LEVELS,
  LOG_SOURCES,
  LogLevel,
  LogRecord,
  Project,
  listProjectLogs,
  listProjects,
  logSourceLabel,
  streamProjectLogs,
} from '../api'

/** 前端保留的最大条数：后端环形缓冲 2000 条，客户端再留一份同量级即可。 */
const MAX_CLIENT = 2000
/** 首屏加载条数：SSE 只推新产生的记录，历史靠这一次拉取补齐。 */
const INITIAL_LIMIT = 500
/** 事件攒批间隔：日志可能每秒几十条，攒一下再交给 React 渲染，避免把界面刷爆。 */
const FLUSH_MS = 150

type ConnState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'

const STATE_META: Record<ConnState, { color: string; text: string; tip: string }> = {
  idle: { color: 'default', text: '未连接', tip: '请选择一个项目' },
  connecting: { color: 'processing', text: '连接中', tip: '正在建立实时通道并补齐历史日志' },
  live: { color: 'success', text: '实时接收中', tip: '已连接，新日志会即时出现在下方' },
  reconnecting: { color: 'warning', text: '重连中', tip: '实时通道断开，浏览器正在自动重连' },
  error: { color: 'error', text: '已断开', tip: '无法接收实时日志，请确认后端服务在运行' },
}

const levelMeta = (lv: LogLevel) => LOG_LEVELS.find((l) => l.key === lv) || LOG_LEVELS[1]

const fmtTime = (ts: string) => (ts || '').slice(11) || ts

/**
 * 列表一行一条日志：把内部换行折成一个 ↵ 标记，长文本交给 CSS 省略号。
 * 想读全文就点这一行展开（只有被点开的那一行才允许多行），这样列表的高度始终是可控的。
 */
const toSingleLine = (text: string) => (text || '').replace(/\r\n?|\n/g, ' ↵ ')

export default function LogViewer() {
  const token = useToken()
  const { message } = AntdApp.useApp()

  const [projects, setProjects] = useState<Project[]>([])
  const [pid, setPid] = useState<number | null>(null)
  const [records, setRecords] = useState<LogRecord[]>([])
  const [conn, setConn] = useState<ConnState>('idle')
  const [notice, setNotice] = useState('')
  const [buffered, setBuffered] = useState(0)
  const [capacity, setCapacity] = useState(2000)
  const [levels, setLevels] = useState<LogLevel[]>(LOG_LEVELS.map((l) => l.key))
  const [sources, setSources] = useState<string[]>([])
  const [kw, setKw] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [includeGlobal, setIncludeGlobal] = useState(false)
  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<LogRecord[] | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [projectLoading, setProjectLoading] = useState(true)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const pendingRef = useRef<LogRecord[]>([])
  const flushTimer = useRef<number | null>(null)
  const stickBottom = useRef(true)

  // ---------------- 项目列表 ----------------
  useEffect(() => {
    let alive = true
    setProjectLoading(true)
    listProjects(token)
      .then((ps) => {
        if (!alive) return
        setProjects(ps)
        setPid((cur) => (cur != null && ps.some((p) => p.id === cur) ? cur : ps[0]?.id ?? null))
      })
      .catch((e) => alive && message.error(String(e.message || e)))
      .finally(() => alive && setProjectLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // ---------------- 攒批入列 ----------------
  const mergeRecords = useCallback((incoming: LogRecord[]) => {
    if (!incoming.length) return
    setRecords((prev) => {
      const seen = new Set(prev.map((r) => r.seq))
      const add = incoming.filter((r) => !seen.has(r.seq))
      if (!add.length) return prev
      // 首屏拉取与 SSE 推送可能交错到达，按 seq 重排才能保证阅读顺序正确
      const next = prev.concat(add).sort((a, b) => a.seq - b.seq)
      return next.length > MAX_CLIENT ? next.slice(next.length - MAX_CLIENT) : next
    })
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current != null) return
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null
      const batch = pendingRef.current
      pendingRef.current = []
      mergeRecords(batch)
    }, FLUSH_MS)
  }, [mergeRecords])

  // ---------------- 拉历史 + 订阅实时流 ----------------
  useEffect(() => {
    if (pid == null) {
      setConn('idle')
      return
    }
    let alive = true
    setRecords([])
    pendingRef.current = []
    setNotice('')
    setConn('connecting')
    setFrozen(null)
    setPaused(false)
    stickBottom.current = true

    listProjectLogs(token, pid, { after_seq: 0, limit: INITIAL_LIMIT, include_global: includeGlobal })
      .then((page) => {
        if (!alive) return
        mergeRecords(page.records)
        setBuffered(page.buffered)
        setCapacity(page.capacity)
        if (page.dropped) setNotice(`更早的日志已被滚出缓冲（上限 ${page.capacity} 条）`)
        else if (page.truncated) setNotice(`已加载最近 ${INITIAL_LIMIT} 条，更早的记录未显示`)
      })
      .catch((e) => {
        if (!alive) return
        setNotice(String(e.message || e))
      })

    const es = streamProjectLogs(pid, token, { after_seq: 0, include_global: includeGlobal })
    es.onmessage = (ev: MessageEvent) => {
      if (!alive) return
      let d: any
      try {
        d = JSON.parse(ev.data)
      } catch {
        return
      }
      if (d.type === 'log' && d.record) {
        pendingRef.current.push(d.record as LogRecord)
        scheduleFlush()
      } else if (d.type === 'hello') {
        setConn('live')
        if (typeof d.buffered === 'number') setBuffered(d.buffered)
        if (typeof d.capacity === 'number') setCapacity(d.capacity)
      } else if (d.type === 'gap') {
        setNotice(String(d.text || ''))
      } else if (d.type === 'error') {
        setConn('error')
        setNotice(String(d.text || '实时日志通道被服务端拒绝'))
        es.close()
      }
    }
    es.onerror = () => {
      if (!alive) return
      if (es.readyState === EventSource.CLOSED) {
        setConn('error')
        setNotice('实时通道已断开，请确认后端服务在运行')
      } else {
        setConn('reconnecting')
      }
    }

    return () => {
      alive = false
      es.close()
    }
  }, [pid, includeGlobal, token, mergeRecords, scheduleFlush])

  useEffect(() => () => {
    if (flushTimer.current != null) window.clearTimeout(flushTimer.current)
  }, [])

  // ---------------- 展示层过滤（本地做，切筛选不断流） ----------------
  const source2 = paused && frozen ? frozen : records

  const visible = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return source2.filter((r) => {
      if (!levels.includes(r.level)) return false
      if (sources.length && !sources.includes(r.source)) return false
      if (k && !r.text.toLowerCase().includes(k)) return false
      return true
    })
  }, [source2, levels, sources, kw])

  // 新日志到达时贴底；用户自己往上翻则不再打扰
  useEffect(() => {
    if (!autoScroll || paused) return
    const box = boxRef.current
    if (!box || !stickBottom.current) return
    box.scrollTop = box.scrollHeight
  }, [visible.length, autoScroll, paused])

  const onScroll = () => {
    const box = boxRef.current
    if (!box) return
    stickBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24
  }

  const togglePause = () => {
    if (paused) {
      setFrozen(null)
      setPaused(false)
      stickBottom.current = true
    } else {
      // 暂停只是冻结屏幕，后台仍在累积 —— 恢复时不会丢任何一条
      setFrozen(records)
      setPaused(true)
    }
  }

  const asText = () =>
    visible
      .map((r) => `${r.ts} [${r.level.toUpperCase()}] (${r.source}) ${r.text.replace(/\n/g, ' ')}`)
      .join('\n')

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(asText())
      message.success(`已复制 ${visible.length} 条日志`)
    } catch (e: any) {
      message.error(`复制失败：${e?.message || e}`)
    }
  }

  const download = () => {
    const blob = new Blob([asText()], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const proj = projects.find((p) => p.id === pid)
    a.href = url
    a.download = `${proj?.name || `project-${pid}`}-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const toggleRow = (seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }

  const levelTag = (lv: LogLevel) => {
    const on = levels.includes(lv)
    const meta = levelMeta(lv)
    return (
      <Tag.CheckableTag
        key={lv}
        checked={on}
        onChange={(ck) =>
          setLevels((prev) => (ck ? [...prev, lv] : prev.filter((x) => x !== lv)))
        }
        style={{
          border: '1px solid',
          borderColor: on ? meta.color : '#dcdfe6',
          color: on ? meta.color : '#8f959e',
          background: on ? `${meta.color}14` : 'transparent',
          borderRadius: 6,
          paddingInline: 8,
        }}
      >
        {meta.label}
      </Tag.CheckableTag>
    )
  }

  const state = STATE_META[conn]
  const proj = projects.find((p) => p.id === pid)

  return (
    <div className="rl-root">
      <Card styles={{ body: { padding: '18px 20px' } }} style={{ marginBottom: 12 }}>
        <div className="rl-head">
          <div style={{ minWidth: 0 }}>
            {/* 面包屑已经写了「实时日志」，这里放当前对象（项目），避免同一个词在一屏里出现两次 */}
            <div className="rl-title" title={proj?.name}>
              {proj ? proj.name : pid == null ? '未选择项目' : `项目 #${pid}`}
            </div>
            <div className="rl-sub">
              实时观测这个项目正在发生什么：Agent 原始输出、会话运行、文件改动与操作留痕。
              日志保存在后端内存的环形缓冲里（不落库、重启即清空），需要长期追溯请到管理台的审计页。
            </div>
          </div>
          <Space size={10} wrap>
            <Select
              style={{ minWidth: 220 }}
              value={pid ?? undefined}
              loading={projectLoading}
              placeholder="选择项目"
              onChange={(v) => setPid(v)}
              options={projects.map((p) => ({ value: p.id, label: `${p.name}（#${p.id}）` }))}
              notFoundContent={<span style={{ fontSize: 12 }}>当前凭证下没有可访问的项目</span>}
            />
            <Tooltip title={state.tip}>
              <Tag color={state.color} className="rl-state">
                {state.text}
              </Tag>
            </Tooltip>
          </Space>
        </div>
      </Card>

      <Card styles={{ body: { padding: 14 } }} style={{ marginBottom: 12 }}>
        <div className="rl-toolbar">
          <Space size={6} wrap align="center">
            <span className="rl-label">级别</span>
            {LOG_LEVELS.map((l) => levelTag(l.key))}
          </Space>
          <Space size={6} wrap align="center">
            <span className="rl-label">来源</span>
            <Select
              mode="multiple"
              allowClear
              maxTagCount="responsive"
              placeholder="全部来源"
              style={{ minWidth: 200 }}
              value={sources}
              onChange={setSources}
              options={LOG_SOURCES.map((s) => ({ value: s.key, label: s.label }))}
            />
          </Space>
          <Input
            allowClear
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜索日志内容…"
            style={{ width: 220 }}
          />
          <Tooltip title="把后端平台级日志（如未绑定项目的 Agent 一键测试）也一并显示">
            <Space size={6} align="center">
              <span className="rl-label">平台日志</span>
              <Switch size="small" checked={includeGlobal} onChange={setIncludeGlobal} />
            </Space>
          </Tooltip>
          <Tooltip title="仅控制是否自动贴到底部；向上翻动时本就不再打扰">
            <Space size={6} align="center">
              <span className="rl-label">自动滚动</span>
              <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
            </Space>
          </Tooltip>
          <span style={{ flex: 1 }} />
          <Space size={8} wrap>
            <Tooltip title={paused ? '恢复滚动到最新日志' : '冻结屏幕：后台仍在累积，恢复后一条不丢'}>
              <Button
                size="small"
                icon={paused ? <CaretRightOutlined /> : <PauseOutlined />}
                onClick={togglePause}
                type={paused ? 'primary' : 'default'}
              >
                {paused ? '继续' : '暂停'}
              </Button>
            </Tooltip>
            <Button
              size="small"
              icon={<VerticalAlignBottomOutlined />}
              disabled={!visible.length}
              onClick={() => {
                stickBottom.current = true
                const box = boxRef.current
                if (box) box.scrollTop = box.scrollHeight
              }}
            >
              置底
            </Button>
            <Button
              size="small"
              icon={<CopyOutlined />}
              disabled={!visible.length}
              onClick={copyAll}
            >
              复制
            </Button>
            <Button
              size="small"
              icon={<CloudDownloadOutlined />}
              disabled={!visible.length}
              onClick={download}
            >
              下载
            </Button>
            <Tooltip title="只清空当前屏幕上的记录，后端缓冲不动">
              <Button size="small" icon={<ClearOutlined />} disabled={!records.length} onClick={() => {
                setRecords([])
                setFrozen(null)
                pendingRef.current = []
              }}>
                清屏
              </Button>
            </Tooltip>
          </Space>
        </div>

        <div className="rl-meta">
          显示 <b>{visible.length}</b> 条 · 本地累计 <b>{records.length}</b> 条 · 后端缓冲{' '}
          <b>{buffered}</b>/{capacity}
          <span className="rl-hint">一行一条，点任意一行可展开全文</span>
          {paused && <span className="rl-paused">已暂停，屏幕已冻结</span>}
        </div>

        {notice && (
          <Alert
            type="warning"
            showIcon
            closable
            style={{ marginBottom: 10 }}
            message={notice}
            onClose={() => setNotice('')}
          />
        )}

        <div className="rl-console" ref={boxRef} onScroll={onScroll}>
          {pid == null ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={projectLoading ? '正在加载项目…' : '请先选择一个项目'}
            />
          ) : visible.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                records.length
                  ? '当前筛选条件下没有匹配的日志'
                  : '还没有日志。在这个项目里运行一次 Agent，或改一个文件，日志会实时出现在这里。'
              }
            />
          ) : (
            visible.map((r) => {
              const meta = levelMeta(r.level)
              const isOpen = expanded.has(r.seq)
              return (
                <div
                  className={`rl-row rl-${r.level}${isOpen ? ' rl-row-open' : ''}`}
                  key={r.seq}
                  onClick={() => toggleRow(r.seq)}
                  title={isOpen ? '点击收起' : '点击展开全文'}
                >
                  <span className="rl-seq">{r.seq}</span>
                  <span className="rl-time" title={r.ts}>
                    {fmtTime(r.ts)}
                  </span>
                  <span className="rl-level" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <span className="rl-src">{logSourceLabel(r.source)}</span>
                  <span className="rl-text">{isOpen ? r.text : toSingleLine(r.text)}</span>
                </div>
              )
            })
          )}
        </div>
      </Card>

      {proj && (
        <div className="rl-foot">
          工作目录 <code>{proj.disk_path}</code> · 日志只保留最近 {capacity} 条，更早的会被滚出
        </div>
      )}
    </div>
  )
}
