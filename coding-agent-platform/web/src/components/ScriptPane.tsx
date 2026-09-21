import { useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography,
} from 'antd'
import {
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  FormOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import {
  ScriptItem,
  ScriptParamDef,
  ScriptRunRecord,
  deleteScript,
  describeError,
  getScript,
  listScriptRuns,
  listScripts,
  runScript,
  saveScript,
} from '../api'
import { scriptAssistPrompt } from './FlowCommands'
import { CodeView } from './FileViewer'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

const SORT_KEY = 'cap_script_list_sort'
type ScriptSort = 'name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc'

function loadSort(): ScriptSort {
  try {
    const v = localStorage.getItem(SORT_KEY)
    if (v === 'name-asc' || v === 'name-desc' || v === 'mtime-desc' || v === 'mtime-asc') return v
  } catch {
    /* localStorage 不可用时回落默认 */
  }
  return 'name-asc'
}

function compareName(a: ScriptItem, b: ScriptItem): number {
  const an = a.display_name || a.name
  const bn = b.display_name || b.name
  const byDisplay = an.localeCompare(bn, 'zh')
  return byDisplay || a.name.localeCompare(b.name, 'zh')
}

function compareMtime(a: ScriptItem, b: ScriptItem): number {
  return (a.mtime || '').localeCompare(b.mtime || '') || compareName(a, b)
}

/** 从脚本文件名取扩展名，供语法高亮映射。 */
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

const DEFAULT_TEMPLATE = (display: string) => `---
name: ${display}
desc:
params: []
---
# 在此编写脚本正文；参数通过 CLI --name value 传入
print("hello")
`

function buildInitialParams(item: ScriptItem): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  const last = item.last_params || {}
  for (const p of item.params || []) {
    if (last[p.name] !== undefined) {
      if (p.type === 'boolean') {
        out[p.name] = String(last[p.name]).toLowerCase() === 'true'
      } else if (p.type === 'number') {
        const n = Number(last[p.name])
        out[p.name] = Number.isFinite(n) ? n : (p.default as number) ?? 0
      } else {
        out[p.name] = last[p.name]
      }
    } else if (p.default !== undefined && p.default !== null) {
      out[p.name] = p.default as string | number | boolean
    }
  }
  return out
}

function missingRequired(params: ScriptParamDef[], values: Record<string, string | number | boolean>) {
  return (params || []).filter((p) => {
    if (!p.required) return false
    const v = values[p.name]
    return v === undefined || v === null || v === ''
  })
}

/**
 * 通用脚本面板：.janus/{dir}/script/ 列表，支持参数 / 编辑 / 执行 / 日志 / AI 协助。
 * 与用例面板的 usecase/accept.* 总验收脚本分离。
 */
export default function ScriptPane({
  token,
  rid,
  dir,
  busy,
  refreshSignal = 0,
  onUseCommand,
}: {
  token: string | null
  rid: number | null
  dir: string
  busy?: boolean
  refreshSignal?: number
  onUseCommand: (text: string) => void
}) {
  const { message, modal } = AntdApp.useApp()
  const [items, setItems] = useState<ScriptItem[]>([])
  const [loading, setLoading] = useState(false)
  const [runningName, setRunningName] = useState<string | null>(null)

  const [paramOpen, setParamOpen] = useState<ScriptItem | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, string | number | boolean>>({})

  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  /** preview=语法高亮渲染；edit=源码编辑。 */
  const [editView, setEditView] = useState<'preview' | 'edit'>('edit')

  const [logsOpen, setLogsOpen] = useState(false)
  const [logsName, setLogsName] = useState('')
  const [logs, setLogs] = useState<ScriptRunRecord[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [activeRun, setActiveRun] = useState<ScriptRunRecord | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createStem, setCreateStem] = useState('new_script')
  const [createExt, setCreateExt] = useState<'py' | 'sh' | 'js' | 'mjs'>('py')
  const [sortBy, setSortBy] = useState<ScriptSort>(() => loadSort())

  const disabled = rid === null || !dir

  const load = async (silent = false) => {
    if (rid === null) {
      setItems([])
      return
    }
    if (!silent) setLoading(true)
    try {
      setItems(await listScripts(token, rid))
    } catch (e) {
      if (!silent) {
        const info = describeError(e)
        message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, token, refreshSignal])

  const openParams = (item: ScriptItem) => {
    setParamValues(buildInitialParams(item))
    setParamOpen(item)
  }

  const doRun = async (item: ScriptItem, values: Record<string, string | number | boolean>) => {
    if (rid === null || runningName) return
    const miss = missingRequired(item.params, values)
    if (miss.length) {
      message.warning(`请填写必填参数：${miss.map((p) => p.label || p.name).join('、')}`)
      openParams(item)
      return
    }
    setRunningName(item.name)
    try {
      const r = await runScript(token, rid, item.name, values)
      if (!r.ran) {
        message.error(`未能执行：${r.reason || '未知原因'}${r.detail ? ' · ' + r.detail : ''}`)
        return
      }
      message[r.exit_code === 0 ? 'success' : 'warning'](
        `已执行 ${item.name}（退出码 ${r.exit_code}，${r.duration_ms ?? 0}ms）`,
      )
      await load(true)
      setLogsName(item.name)
      setLogsOpen(true)
      if (r.run) {
        setActiveRun(r.run)
        setLogs((prev) => [r.run!, ...prev.filter((x) => x.id !== r.run!.id)])
      } else {
        void openLogs(item.name)
      }
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setRunningName(null)
    }
  }

  const onExecuteClick = (item: ScriptItem) => {
    const values = buildInitialParams(item)
    const miss = missingRequired(item.params, values)
    if (miss.length || (item.params || []).length > 0) {
      // 有参数时优先打开参数表（预填上次），避免误跑；无必填缺省可直接点「执行」
      if (miss.length) {
        openParams(item)
        return
      }
    }
    void doRun(item, values)
  }

  const openEdit = async (item: ScriptItem) => {
    if (rid === null) return
    try {
      const full = await getScript(token, rid, item.name)
      setEditName(full.name)
      setEditContent(full.content || '')
      setEditView('edit')
      setEditOpen(true)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    }
  }

  const saveEdit = async () => {
    if (rid === null || !editName) return
    setEditSaving(true)
    try {
      await saveScript(token, rid, editName, editContent)
      message.success('已保存')
      setEditOpen(false)
      await load(true)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setEditSaving(false)
    }
  }

  const openLogs = async (name: string) => {
    if (rid === null) return
    setLogsName(name)
    setLogsOpen(true)
    setLogsLoading(true)
    setActiveRun(null)
    try {
      const rows = await listScriptRuns(token, rid, name)
      setLogs(rows)
      setActiveRun(rows[0] || null)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setLogsLoading(false)
    }
  }

  const onDelete = (item: ScriptItem) => {
    if (rid === null) return
    modal.confirm({
      title: `删除脚本 ${item.name}？`,
      content: '将同时删除对应的执行记录，此操作不可恢复。',
      okType: 'danger',
      onOk: async () => {
        try {
          await deleteScript(token, rid, item.name)
          message.success('已删除')
          await load(true)
        } catch (e) {
          const info = describeError(e)
          message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
        }
      },
    })
  }

  const createScript = async () => {
    if (rid === null) return
    const stem = (createStem || '').trim().replace(/[^\w.-]/g, '_') || 'new_script'
    const name = `${stem}.${createExt}`
    try {
      await saveScript(token, rid, name, DEFAULT_TEMPLATE(stem))
      message.success(`已创建 ${name}`)
      setCreateOpen(false)
      await load(true)
      setEditName(name)
      setEditContent(DEFAULT_TEMPLATE(stem))
      setEditView('edit')
      setEditOpen(true)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    }
  }

  const sortedItems = useMemo(() => {
    const list = [...items]
    if (sortBy === 'name-desc') list.sort((a, b) => compareName(b, a))
    else if (sortBy === 'mtime-desc') list.sort((a, b) => compareMtime(b, a))
    else if (sortBy === 'mtime-asc') list.sort(compareMtime)
    else list.sort(compareName)
    return list
  }, [items, sortBy])

  const changeSort = (v: ScriptSort) => {
    setSortBy(v)
    try {
      localStorage.setItem(SORT_KEY, v)
    } catch {
      /* ignore */
    }
  }

  const aiAssist = () => {
    onUseCommand(scriptAssistPrompt(dir))
  }

  const paramForm = useMemo(() => {
    if (!paramOpen) return null
    return (paramOpen.params || []).map((p) => {
      const val = paramValues[p.name]
      if (p.type === 'boolean') {
        return (
          <Form.Item key={p.name} label={p.label || p.name} required={p.required}>
            <Switch
              checked={Boolean(val)}
              onChange={(c) => setParamValues((v) => ({ ...v, [p.name]: c }))}
            />
          </Form.Item>
        )
      }
      if (p.type === 'number') {
        return (
          <Form.Item key={p.name} label={p.label || p.name} required={p.required}>
            <InputNumber
              style={{ width: '100%' }}
              value={typeof val === 'number' ? val : undefined}
              onChange={(n) => setParamValues((v) => ({ ...v, [p.name]: n ?? 0 }))}
            />
          </Form.Item>
        )
      }
      if (p.type === 'select') {
        return (
          <Form.Item key={p.name} label={p.label || p.name} required={p.required}>
            <Select
              style={{ width: '100%' }}
              placeholder="请选择"
              value={val === undefined || val === null || val === '' ? undefined : String(val)}
              options={(p.options || []).map((o) => ({ value: o.value, label: o.label || o.value }))}
              onChange={(v) => setParamValues((prev) => ({ ...prev, [p.name]: v }))}
            />
          </Form.Item>
        )
      }
      return (
        <Form.Item key={p.name} label={p.label || p.name} required={p.required}>
          <Input
            value={val === undefined || val === null ? '' : String(val)}
            onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.value }))}
          />
        </Form.Item>
      )
    })
  }, [paramOpen, paramValues])

  if (disabled) {
    return (
      <div className="script-pane">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择需求" style={{ marginTop: 48 }} />
      </div>
    )
  }

  return (
    <div className="script-pane">
      <div className="script-toolbar">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          目录 .janus/{dir}/script/
        </Typography.Text>
        <Space size={6} wrap>
          <Select
            size="small"
            value={sortBy}
            style={{ width: 120 }}
            onChange={changeSort}
            options={[
              { value: 'name-asc', label: '名称 A→Z' },
              { value: 'name-desc', label: '名称 Z→A' },
              { value: 'mtime-desc', label: '最近修改' },
              { value: 'mtime-asc', label: '最早修改' },
            ]}
          />
          <Button size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建
          </Button>
          <Button size="small" icon={<ThunderboltOutlined />} disabled={busy} onClick={aiAssist}>
            AI 协助写脚本
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      </div>

      {loading && items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" style={{ marginTop: 48 }} />
      ) : items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有脚本：可新建，或让 AI 协助写到 .janus/.../script/"
          style={{ marginTop: 48 }}
        >
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建脚本
            </Button>
            <Button icon={<ThunderboltOutlined />} disabled={busy} onClick={aiAssist}>
              AI 协助
            </Button>
          </Space>
        </Empty>
      ) : (
        <div className="script-list">
          {sortedItems.map((it) => {
            const running = runningName === it.name
            return (
              <div key={it.name} className="script-row">
                <div className="script-row-main">
                  <div className="script-row-title">
                    <CodeOutlined />
                    <span className="script-row-name">{it.display_name || it.name}</span>
                    <span className="script-row-file">{it.name}</span>
                  </div>
                  {it.desc ? <div className="script-row-desc">{it.desc}</div> : null}
                  <div className="script-row-meta">
                    {(it.params || []).length > 0
                      ? `${it.params.length} 个参数`
                      : '无参数'}
                    {it.run_count ? ` · ${it.run_count} 次执行` : ''}
                    {it.mtime ? ` · ${it.mtime.slice(5, 16)}` : ''}
                  </div>
                </div>
                <div className="script-row-actions">
                  <Tooltip title="参数">
                    <Button
                      size="small"
                      icon={<FormOutlined />}
                      disabled={running}
                      onClick={() => openParams(it)}
                    />
                  </Tooltip>
                  <Tooltip title="编辑">
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      disabled={running}
                      onClick={() => void openEdit(it)}
                    />
                  </Tooltip>
                  <Tooltip title="执行">
                    <Button
                      size="small"
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      loading={running}
                      onClick={() => onExecuteClick(it)}
                    />
                  </Tooltip>
                  <Tooltip title="日志">
                    <Button
                      size="small"
                      icon={<UnorderedListOutlined />}
                      disabled={running}
                      onClick={() => void openLogs(it.name)}
                    />
                  </Tooltip>
                  <Tooltip title="删除">
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={running}
                      onClick={() => onDelete(it)}
                    />
                  </Tooltip>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        title={paramOpen ? `参数 · ${paramOpen.display_name || paramOpen.name}` : '参数'}
        open={!!paramOpen}
        onCancel={() => setParamOpen(null)}
        width={480}
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={() => setParamOpen(null)}>取消</Button>
            <Button
              type="primary"
              loading={!!runningName}
              onClick={() => {
                if (!paramOpen) return
                void doRun(paramOpen, paramValues).then(() => setParamOpen(null))
              }}
            >
              保存参数并执行
            </Button>
          </Space>
        }
      >
        {(paramOpen?.params || []).length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该脚本未声明参数" />
        ) : (
          <Form layout="vertical">{paramForm}</Form>
        )}
      </Modal>

      <Modal
        title={
          <Space size={8} wrap>
            <CodeOutlined style={{ color: 'var(--primary)' }} />
            <span>编辑 · {editName}</span>
          </Space>
        }
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        width="92vw"
        style={{ top: 24, maxWidth: '92vw', paddingBottom: 0 }}
        wrapClassName="script-edit-modal"
        destroyOnHidden
        footer={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-4)' }}>
              {editView === 'edit' ? 'Ctrl / ⌘ + S 保存' : '切换到「源码」可编辑'}
            </span>
            <Space>
              <Button onClick={() => setEditOpen(false)}>关闭</Button>
              <Button type="primary" loading={editSaving} disabled={editView === 'preview'} onClick={() => void saveEdit()}>
                保存
              </Button>
            </Space>
          </div>
        }
      >
        <div className="script-edit-stage">
          <div style={{ marginBottom: 10 }}>
            <Segmented
              size="small"
              value={editView}
              onChange={(v) => setEditView(v as 'preview' | 'edit')}
              options={[
                { label: '语法高亮', value: 'preview' },
                { label: '源码', value: 'edit' },
              ]}
            />
          </div>
          {editView === 'preview' ? (
            <div className="script-edit-preview">
              <CodeView code={editContent} ext={extOf(editName)} />
            </div>
          ) : (
            <Input.TextArea
              value={editContent}
              spellCheck={false}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault()
                  void saveEdit()
                }
              }}
              className="script-edit-source"
              style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6 }}
            />
          )}
        </div>
      </Modal>

      <Modal
        title={`执行日志 · ${logsName}`}
        open={logsOpen}
        onCancel={() => setLogsOpen(false)}
        width={780}
        destroyOnHidden
        footer={
          <Button onClick={() => setLogsOpen(false)}>关闭</Button>
        }
      >
        {logsLoading ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
        ) : logs.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行记录" />
        ) : (
          <div className="script-logs">
            <div className="script-logs-list">
              {logs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`script-log-item${activeRun?.id === r.id ? ' is-active' : ''}`}
                  onClick={() => setActiveRun(r)}
                >
                  <span>{r.started_at}</span>
                  <span className={r.exit_code === 0 ? 'is-ok' : 'is-bad'}>exit {r.exit_code}</span>
                </button>
              ))}
            </div>
            {activeRun && (
              <div className="script-log-detail">
                <div className="script-log-meta">
                  {activeRun.duration_ms}ms
                  {Object.keys(activeRun.params || {}).length > 0 && (
                    <span>
                      {' '}
                      · params {JSON.stringify(activeRun.params)}
                    </span>
                  )}
                </div>
                <pre className="script-log-out">{activeRun.output || '（无输出）'}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        title="新建脚本"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void createScript()}
        okText="创建"
      >
        <Form layout="vertical">
          <Form.Item label="文件名（不含扩展名）" required>
            <Input value={createStem} onChange={(e) => setCreateStem(e.target.value)} />
          </Form.Item>
          <Form.Item label="类型">
            <Select
              value={createExt}
              onChange={(v) => setCreateExt(v)}
              options={[
                { value: 'py', label: 'Python (.py)' },
                { value: 'sh', label: 'Shell (.sh)' },
                { value: 'js', label: 'JavaScript (.js)' },
                { value: 'mjs', label: 'ES Module (.mjs)' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
