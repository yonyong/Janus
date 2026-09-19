import { useEffect, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Avatar,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd'
import { DeleteOutlined, EditOutlined, HolderOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons'
import {
  createAgent,
  deleteAgent,
  listAgents,
  reorderAgents,
  testAgent,
  updateAgent,
  adminState,
  Agent,
  AgentTestResult,
} from '../api'
import { useAuth } from '../auth'

/** Token 日限额默认值：1000 万/天（与后端 AgentRepo.DEFAULT_TOKEN_LIMIT 保持一致）。 */
const DEFAULT_TOKEN_LIMIT = 10000000

/** Token 数按「万 / 亿」缩写，避免一长串数字没法读。 */
function fmtTokens(n?: number | null): string {
  const v = Number(n || 0)
  if (v >= 100000000) return `${Number((v / 100000000).toFixed(2))}亿`
  if (v >= 10000) return `${Number((v / 10000).toFixed(1))}万`
  return String(v)
}

/** 把库里存的 config（JSON 文本或对象）整理成便于编辑的多行 JSON。 */
function configTextOf(c: unknown): string {
  if (c === null || c === undefined) return '{}'
  if (typeof c === 'string') {
    try {
      return JSON.stringify(JSON.parse(c), null, 2)
    } catch {
      return c
    }
  }
  return JSON.stringify(c, null, 2)
}

/** 把库里存的 config 解析成对象（JSON 文本解析失败或非对象时回空），便于取 model 等字段。 */
function configObjOf(c: unknown): Record<string, any> {
  if (c === null || c === undefined) return {}
  if (typeof c === 'string') {
    try {
      const v = JSON.parse(c)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch {
      return {}
    }
  }
  return typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, any>) : {}
}

/** 平台支持的正式 CLI 类型（与后端 _CLI_SPECS / AgentRegistry 注册保持一致）。 */
const CLI_TYPES = ['claude', 'codex', 'cursor', 'codebuddy'] as const

/** 各类型的展示名与默认 CLI 命令（与后端规格表保持一致）。 */
const CLI_TYPE_META: Record<
  (typeof CLI_TYPES)[number],
  { label: string; cmd: string; apiKeyEnv: string }
> = {
  claude: { label: 'Claude Code', cmd: 'claude', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  codex: { label: 'Codex', cmd: 'codex', apiKeyEnv: 'OPENAI_API_KEY' },
  cursor: { label: 'Cursor', cmd: 'cursor-agent', apiKeyEnv: 'CURSOR_API_KEY' },
  codebuddy: { label: 'CodeBuddy', cmd: 'codebuddy', apiKeyEnv: 'CODEBUDDY_API_KEY' },
}

/**
 * API Key 掩码哨兵（与后端 app.API_KEY_MASK 约定一致）：
 * 列表里已配置的 key 掩码回显为该值，保存时原样传回表示「保留原 key」，
 * 清空表示删除，输入新值表示覆盖。
 */
const API_KEY_MASK = '__MASKED__'

/** 切换类型时把 config JSON 里的 cmd 同步成新类型的默认命令。
 *
 * 只在 cmd 键已存在（显式覆盖过）或 config 为空对象时改写——用户手写的其他键
 * 一律保留；JSON 不合法时原样返回，交给保存时的校验提示。
 */
function syncCmdInConfigText(text: string, cmd: string): string {
  try {
    const obj = JSON.parse(text || '{}')
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return text
    if ('cmd' in obj || Object.keys(obj).length === 0) {
      obj.cmd = cmd
      return JSON.stringify(obj, null, 2)
    }
    return text
  } catch {
    return text
  }
}

const EVENT_COLOR: Record<string, string> = {
  message: 'blue',
  status: 'cyan',
  edit: 'purple',
  test: 'green',
  error: 'red',
  done: 'default',
}

/** 一键测试结果的三态呈现：成功 / 限流 / 超时 / 配置错误。 */
function alertTone(r: AgentTestResult): 'success' | 'warning' | 'error' {
  if (r.ok) return 'success'
  if (r.rate_limited) return 'warning'
  if (r.timed_out) return 'warning'
  return 'error'
}
function alertTitle(r: AgentTestResult): string {
  if (r.ok) return '连接正常'
  if (r.rate_limited) return '连接可达 · 模型被限流'
  if (r.timed_out) return '调用超时'
  return '连接失败'
}
function alertDesc(r: AgentTestResult): string {
  if (r.rate_limited) {
    return `${r.error || '模型调用被频率限制'}。连接本身正常，非配置问题；账户配额重置后即可恢复（默认模型 hy3 限流通常数小时内解除）。`
  }
  if (r.timed_out) {
    return `${r.error || '调用超时'}。若长时间无任何输出（事件流为空），多为 CLI 未正常启动或静默挂死：请先重启后端（环境净化改动需重启才生效），再对照下方事件流——出现 EADDRINUSE / 指向宿主代理的报错即是宿主注入的环境变量所致；确认无误后仍超时，才考虑模型侧限流或网络抖动，稍后重试。`
  }
  return r.error || '未知错误'
}

export default function AgentList() {
  const { message } = AntdApp.useApp()
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  // 弹窗两用：editing 为 null 表示注册新 Agent，非 null 表示编辑该 Agent 的配置。
  const [editing, setEditing] = useState<Agent | null>(null)
  const [saving, setSaving] = useState(false)
  const [type, setType] = useState<string>('claude')
  const [configText, setConfigText] = useState('{}')
  const [form] = Form.useForm()
  // 一键测试：探针消息默认「你好」，结果弹窗展示耗时/事件流/失败原因
  const [testingId, setTestingId] = useState<number | null>(null)
  const [probeMsg, setProbeMsg] = useState('你好')
  const [testResult, setTestResult] = useState<AgentTestResult | null>(null)
  // 后端启用管理员口令且当前不是管理员登录时，注册/删除/测试都会被 401，先给出提示。
  // 管理员态来自统一登录上下文，因此在登录弹框里登录后本页会即时跟上，不需要刷新。
  const { isAdmin } = useAuth()
  const [adminEnabled, setAdminEnabled] = useState(false)

  useEffect(() => {
    adminState()
      .then((s) => setAdminEnabled(!!s.admin_enabled))
      .catch(() => {})
  }, [])

  const adminLocked = adminEnabled && !isAdmin

  // 拖拽排序：记录正在拖动的行，落到目标行时本地重排并提交完整顺序
  const [dragId, setDragId] = useState<number | null>(null)
  const [reordering, setReordering] = useState(false)

  const moveAgent = async (target: Agent) => {
    const from = dragId === null ? -1 : agents.findIndex((a) => a.id === dragId)
    const to = agents.findIndex((a) => a.id === target.id)
    setDragId(null)
    if (from < 0 || to < 0 || from === to) return
    const next = [...agents]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setAgents(next)
    setReordering(true)
    try {
      setAgents(await reorderAgents(next.map((a) => a.id)))
      message.success('排序已保存：AI 任务将优先使用排在前面的可用 Agent')
    } catch (e: any) {
      message.error(String(e.message || e))
      load()
    } finally {
      setReordering(false)
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      setAgents(await listAgents())
    } catch (e: any) {
      message.error(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const openCreate = () => {
    setEditing(null)
    setType('claude')
    setConfigText('{}')
    form.resetFields()
    setOpen(true)
  }

  /** 打开编辑：把当前配置回填进表单，字段直接改、不用先删再建。 */
  const openEdit = (a: Agent) => {
    setEditing(a)
    setType(a.type)
    setConfigText(configTextOf(a.config))
    form.setFieldsValue({
      name: a.name,
      model: String(configObjOf(a.config).model || ''),
      // 已配置的 key 后端掩码返回，回填哨兵值；清空输入框即删除，输入新值即覆盖
      apiKey: a.has_api_key ? API_KEY_MASK : '',
      proxy: String(configObjOf(a.config).proxy || ''),
      tokenLimit: a.token_limit ?? DEFAULT_TOKEN_LIMIT,
    })
    setOpen(true)
  }

  const submit = async () => {
    const v = await form.validateFields()
    let config: Record<string, any> = {}
    try {
      config = JSON.parse(configText || '{}')
    } catch {
      message.error('config 不是合法 JSON')
      return
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      message.error('config 必须是 JSON 对象')
      return
    }
    // 模型名称作为 config.model 落库（codebuddy 适配器会拼 --model）；留空表示用 CLI 默认模型
    const model = String(v.model || '').trim()
    if (model) config.model = model
    else delete config.model
    // API Key：哨兵值原样传回（后端识别为保留原 key）；清空即删除；新值即覆盖
    const apiKey = String(v.apiKey ?? '').trim()
    if (apiKey) config.api_key = apiKey
    else delete config.api_key
    // 代理地址：注入 HTTP_PROXY/HTTPS_PROXY（NO_PROXY 固定排除本机回环）；留空即删除
    const proxy = String(v.proxy || '').trim()
    if (proxy) config.proxy = proxy
    else delete config.proxy
    // Token 限额：0 表示不限额；负数在提交前拦下
    const tokenLimit = Math.max(0, Math.floor(Number(v.tokenLimit ?? DEFAULT_TOKEN_LIMIT) || 0))
    setSaving(true)
    try {
      if (editing) {
        await updateAgent(editing.id, { name: v.name.trim(), type, config, token_limit: tokenLimit })
        message.success('Agent 已更新')
      } else {
        await createAgent({ name: v.name.trim(), type, config, token_limit: tokenLimit })
        message.success('Agent 已注册')
      }
      setOpen(false)
      setEditing(null)
      form.resetFields()
      setConfigText('{}')
      load()
    } catch (e: any) {
      message.error(String(e.message || e))
    } finally {
      setSaving(false)
    }
  }

  /** 一键测试：真实调用一次 provider（隔离临时目录，不改动项目代码），回显是否成功。 */
  const runTest = async (a: Agent, msg?: string) => {
    const text = (msg ?? '').trim() || '你好'
    setProbeMsg(text)
    setTestingId(a.id)
    try {
      const r = await testAgent(a.id, { message: text })
      setTestResult(r)
      if (r.ok) message.success(`测试通过：${a.name} 已响应（${r.elapsed_ms} ms）`)
      else message.error(`测试失败：${r.error || '未知错误'}`)
    } catch (e: any) {
      const raw = String(e.message || e)
      setTestResult({
        ok: false,
        agent_id: a.id,
        agent_name: a.name,
        type: a.type,
        message: text,
        reply: null,
        error: /管理员口令/.test(raw) ? `${raw}（请先到「管理台」解锁管理员口令）` : raw,
        timed_out: false,
        rate_limited: false,
        elapsed_ms: 0,
        events: [],
        workdir: null,
      })
    } finally {
      setTestingId(null)
    }
  }

  const testTarget = testResult ? agents.find((a) => a.id === testResult.agent_id) || null : null

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto' }}>
      <Card styles={{ body: { padding: '20px 24px' } }} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <Space align="center" size={8}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                Agent 管理
              </Typography.Title>
              <Tag color="blue">{agents.length}</Tag>
            </Space>
            <div style={{ color: '#8f959e', fontSize: 13, marginTop: 4 }}>
              注册并维护编码 Agent；拖动行可调整调度优先级 —— 工作台与 AI 任务优先使用排在前面的
              可用 Agent，Token 日限额用满的自动顺位跳过
            </div>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            注册 Agent
          </Button>
        </div>
      </Card>

      {adminLocked && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="后端已启用管理员口令，当前不是管理员登录"
          description="注册 / 编辑 / 删除 / 测试 Agent 均需管理员口令。点右上角账号入口（或管理台「用管理员口令登录」）登录后，本页会自动解除限制。"
        />
      )}

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="已注册" value={agents.length} valueStyle={{ color: '#3370ff' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="正式类型"
              value={agents.filter((a) => (CLI_TYPES as readonly string[]).includes(a.type)).length}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="遗留联调" value={agents.filter((a) => a.type === 'fake').length} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="其他"
              value={agents.filter((a) => !(CLI_TYPES as readonly string[]).includes(a.type) && a.type !== 'fake').length}
            />
          </Card>
        </Col>
      </Row>

      <Card>
        {agents.length === 0 && !loading ? (
          <Empty description="暂无 Agent，点击「注册 Agent」添加第一个" />
        ) : (
          <List
            loading={loading || reordering}
            dataSource={agents}
            renderItem={(a, idx) => (
              <List.Item
                draggable
                onDragStart={() => setDragId(a.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => moveAgent(a)}
                onDragEnd={() => setDragId(null)}
                style={{
                  opacity: dragId === a.id ? 0.4 : a.available === false ? 0.55 : 1,
                  cursor: 'grab',
                }}
                actions={[
                  <Button
                    key="test"
                    type="text"
                    icon={<ThunderboltOutlined />}
                    loading={testingId === a.id}
                    onClick={() => runTest(a)}
                  >
                    测试
                  </Button>,
                  <Button
                    key="edit"
                    type="text"
                    icon={<EditOutlined />}
                    onClick={() => openEdit(a)}
                  >
                    编辑
                  </Button>,
                  <Popconfirm
                    key="del"
                    title="删除该 Agent？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={async () => {
                      await deleteAgent(a.id)
                      message.success('已删除')
                      load()
                    }}
                  >
                    <Button type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <Avatar shape="square" size={40} style={{ background: '#f0f4ff', color: '#3370ff' }}>
                      <HolderOutlined style={{ color: '#b1b6bd' }} />
                    </Avatar>
                  }
                  title={
                    <Space size={8} wrap>
                      <Tag color={idx === 0 ? 'gold' : 'default'} style={{ marginInlineEnd: 0 }}>
                        优先级 {idx + 1}
                      </Tag>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</span>
                      <Tag color="blue">#{a.id}</Tag>
                      <Tag>{a.type}</Tag>
                      {configObjOf(a.config).model && (
                        <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                          {String(configObjOf(a.config).model)}
                        </Tag>
                      )}
                      {a.has_api_key && (
                        <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                          API Key 已配置
                        </Tag>
                      )}
                      {configObjOf(a.config).proxy && (
                        <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
                          代理 {String(configObjOf(a.config).proxy)}
                        </Tag>
                      )}
                      {typeof a.token_limit === 'number' && (
                        <Tag color={a.available === false ? 'red' : 'default'} style={{ marginInlineEnd: 0 }}>
                          {a.token_limit <= 0
                            ? 'Token 不限额'
                            : `Token 今日 ${fmtTokens(a.used_tokens)} / ${fmtTokens(a.token_limit)}`}
                        </Tag>
                      )}
                      {a.available === false && (
                        <Tag color="red" style={{ marginInlineEnd: 0 }}>
                          今日限额已满 · 不可用
                        </Tag>
                      )}
                    </Space>
                  }
                  description={
                    <Typography.Text type="secondary" code style={{ fontSize: 12 }}>
                      {typeof a.config === 'string' ? a.config : JSON.stringify(a.config)}
                    </Typography.Text>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <Modal
        title={editing ? `编辑 Agent · #${editing.id}` : '注册 Agent'}
        open={open}
        onCancel={() => {
          setOpen(false)
          setEditing(null)
        }}
        onOk={submit}
        okText={editing ? '保存' : '注册'}
        cancelText="取消"
        confirmLoading={saving}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }} requiredMark={false}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入 Agent 名称' }]}>
            <Input placeholder="例如：claude-1" />
          </Form.Item>
          <Form.Item label="类型">
            <Segmented
              value={type}
              onChange={(v) => {
                const t = String(v)
                setType(t)
                // 切类型即同步 config.cmd，避免「类型是 Claude、实际还在跑 codebuddy」的错位
                setConfigText((prev) => syncCmdInConfigText(prev, CLI_TYPE_META[t as keyof typeof CLI_TYPE_META].cmd))
              }}
              options={CLI_TYPES.map((t) => ({ label: CLI_TYPE_META[t].label, value: t }))}
            />
          </Form.Item>
          <Form.Item
            name="model"
            label="模型名称"
            extra="保存后写入 config.model，调用对应 CLI 时拼 --model 参数；留空使用该 CLI 的默认模型"
          >
            <Input placeholder="例如 GLM-4.7，留空用默认模型" allowClear />
          </Form.Item>
          <Form.Item
            name="apiKey"
            label="API Key"
            extra={`保存后写入 config.api_key，调用该 CLI 时注入环境变量 ${CLI_TYPE_META[type as keyof typeof CLI_TYPE_META]?.apiKeyEnv || 'API_KEY'}（可用 config.api_key_env 覆盖变量名）；已配置时回显掩码，清空即删除，输入新值即覆盖`}
          >
            <Input.Password
              placeholder="例如 sk-...，留空使用 CLI 已登录的凭证"
              autoComplete="new-password"
              visibilityToggle
            />
          </Form.Item>
          <Form.Item
            name="proxy"
            label="代理地址"
            extra="保存后写入 config.proxy，调用该 CLI 的子进程会注入 HTTP_PROXY / HTTPS_PROXY（NO_PROXY 固定排除 localhost、127.0.0.1）；留空不配置代理"
          >
            <Input placeholder="例如 http://127.0.0.1:7890" allowClear />
          </Form.Item>
          <Form.Item
            name="tokenLimit"
            label="Token 日限额"
            initialValue={DEFAULT_TOKEN_LIMIT}
            extra="每日 Token 用量达到限额后该 Agent 当天不可用（次日自动重置），AI 任务自动顺位使用下一个可用 Agent；0 表示不限额"
          >
            <InputNumber<number>
              min={0}
              step={1000000}
              style={{ width: '100%' }}
              formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              parser={(v) => Number((v || '0').replace(/,/g, ''))}
            />
          </Form.Item>
          <Form.Item
            label="config（JSON）"
            extra={'切换「类型」会自动同步 cmd；「模型名称」保存后写入 config.model。也可直接改 JSON，如 {"args":[]}'}
          >
            <Input.TextArea
              rows={3}
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          <Space size={8}>
            <ThunderboltOutlined style={{ color: '#3370ff' }} />
            <span>测试结果 · {testResult?.agent_name}</span>
          </Space>
        }
        open={!!testResult}
        onCancel={() => setTestResult(null)}
        width={680}
        footer={[
          <Button key="close" onClick={() => setTestResult(null)}>
            关闭
          </Button>,
        ]}
      >
        {testResult && (
          <>
            <Alert
              type={alertTone(testResult)}
              showIcon
              message={alertTitle(testResult)}
              description={
                testResult.ok
                  ? `探针消息「${testResult.message}」已送达并收到响应 · 耗时 ${testResult.elapsed_ms} ms · ${testResult.events.length} 条事件`
                  : alertDesc(testResult)
              }
              style={{ marginBottom: 16 }}
            />

            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Statistic title="耗时" value={testResult.elapsed_ms} suffix="ms" valueStyle={{ fontSize: 20 }} />
              </Col>
              <Col span={8}>
                <Statistic title="事件数" value={testResult.events.length} valueStyle={{ fontSize: 20 }} />
              </Col>
              <Col span={8}>
                <Statistic
                  title="类型"
                  value={testResult.type}
                  valueStyle={{ fontSize: 20 }}
                  formatter={(v) => <span style={{ fontSize: 20 }}>{String(v)}</span>}
                />
              </Col>
            </Row>

            {testResult.reply && (
              <div style={{ marginBottom: 16 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Agent 回复
                </Typography.Text>
                <div
                  style={{
                    marginTop: 6,
                    padding: 12,
                    background: '#f7f8fa',
                    borderRadius: 8,
                    fontSize: 13,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 200,
                    overflow: 'auto',
                  }}
                >
                  {testResult.reply}
                </div>
              </div>
            )}

            <Divider style={{ margin: '4px 0 12px' }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              事件流
            </Typography.Text>
            <List
              size="small"
              dataSource={testResult.events}
              locale={{ emptyText: '未收到任何事件' }}
              style={{ marginTop: 6, maxHeight: 240, overflow: 'auto' }}
              renderItem={(e, i) => (
                <List.Item key={i}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%' }}>
                    <Tag color={EVENT_COLOR[e.type] || 'default'} style={{ marginInlineEnd: 0 }}>
                      {e.type}
                    </Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12, minWidth: 52 }}>
                      {e.pane}
                    </Typography.Text>
                    <Typography.Text style={{ fontSize: 12, flex: 1, wordBreak: 'break-word' }}>
                      {e.text || (e.payload ? JSON.stringify(e.payload) : '')}
                    </Typography.Text>
                  </div>
                </List.Item>
              )}
            />

            <Divider style={{ margin: '12px 0' }} />
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={probeMsg}
                onChange={(e) => setProbeMsg(e.target.value)}
                placeholder="探针消息，默认「你好」"
                onPressEnter={() => testTarget && runTest(testTarget, probeMsg)}
              />
              <Button
                icon={<ThunderboltOutlined />}
                disabled={!testTarget}
                loading={!!testTarget && testingId === testTarget.id}
                onClick={() => testTarget && runTest(testTarget, probeMsg)}
              >
                重新测试
              </Button>
            </Space.Compact>
            <div style={{ color: '#8f959e', fontSize: 12, marginTop: 8 }}>
              探测在一次性临时目录中执行，不建会话、不落库，也不会改动你的项目代码；默认超时 30s。
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
