import { useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
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

  const [logsOpen, setLogsOpen] = useState(false)
  const [logsName, setLogsName] = useState('')
  const [logs, setLogs] = useState<ScriptRunRecord[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [activeRun, setActiveRun] = useState<ScriptRunRecord | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createStem, setCreateStem] = useState('new_script')
  const [createExt, setCreateExt] = useState<'py' | 'sh' | 'js' | 'mjs'>('py')

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
      setEditOpen(true)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
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
          {items.map((it) => {
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

      <Drawer
        title={paramOpen ? `参数 · ${paramOpen.display_name || paramOpen.name}` : '参数'}
        open={!!paramOpen}
        onClose={() => setParamOpen(null)}
        width={400}
        destroyOnClose
        extra={
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
        }
      >
        {(paramOpen?.params || []).length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该脚本未声明参数" />
        ) : (
          <Form layout="vertical">{paramForm}</Form>
        )}
      </Drawer>

      <Drawer
        title={`编辑 · ${editName}`}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        width={560}
        destroyOnClose
        extra={
          <Button type="primary" loading={editSaving} onClick={() => void saveEdit()}>
            保存
          </Button>
        }
      >
        <Input.TextArea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          autoSize={{ minRows: 18, maxRows: 36 }}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
        />
      </Drawer>

      <Drawer
        title={`日志 · ${logsName}`}
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        width={560}
        destroyOnClose
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
      </Drawer>

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
