import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  FieldTimeOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import {
  ACTOR_TYPE_LABELS,
  AgentInvocation,
  InvocationStats,
  INVOCATION_SOURCE_LABELS,
  adminInvocationDetail,
  adminInvocations,
} from '../api'

/** 分页：默认 10 条/页，可在分页器里调整为 10/20/50/100。 */
const DEFAULT_PAGE_SIZE = 10
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

type RangeValue = [Dayjs | null, Dayjs | null] | null

const rangeParam = (r: RangeValue, idx: 0 | 1): string => {
  const d = r?.[idx]
  return d ? d.format('YYYY-MM-DD') : ''
}

/** 耗时统一成好读的形式：毫秒级看毫秒，超过 1s 看秒。 */
export function fmtElapsed(ms: number): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** Token 数带千分位；为空表示这次调用没有用量信息（不是 0）。 */
function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US')
}

/** 成败三态：失败里再区分超时 / 限流，排查时一眼能分方向。 */
function statusOf(r: AgentInvocation): { label: string; color: string; tip: string } {
  if (r.status === 'success') return { label: '成功', color: 'success', tip: '调用成功' }
  if (r.timed_out) return { label: '超时', color: 'warning', tip: r.error || '调用超时' }
  if (r.rate_limited) return { label: '限流', color: 'warning', tip: r.error || '模型限流' }
  return { label: '失败', color: 'error', tip: r.error || '调用失败' }
}

async function copyText(text: string, ok: () => void, fail: (m: string) => void) {
  try {
    await navigator.clipboard.writeText(text)
    ok()
  } catch (e: any) {
    fail(String(e?.message || e))
  }
}

export default function TokenAudit() {
  const { message } = AntdApp.useApp()

  const [rows, setRows] = useState<AgentInvocation[]>([])
  const [stats, setStats] = useState<InvocationStats | null>(null)
  const [agents, setAgents] = useState<{ id: number; name: string; type: string }[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  const [kw, setKw] = useState('')
  const [q, setQ] = useState('')
  const [source, setSource] = useState<string | undefined>()
  const [status, setStatus] = useState<string | undefined>()
  const [agentId, setAgentId] = useState<number | undefined>()
  const [range, setRange] = useState<RangeValue>(null)

  // 详情单独拉：列表只带入参/出参的开头，全文按需取，避免一页几十万字。
  const [detail, setDetail] = useState<(AgentInvocation & { prompt: string; response: string }) | null>(
    null,
  )
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(
    async (targetPage = page, size = pageSize) => {
      setLoading(true)
      try {
        const res = await adminInvocations({
          limit: size,
          offset: (targetPage - 1) * size,
          q: q || undefined,
          source,
          status,
          agent_id: agentId,
          start: rangeParam(range, 0) || undefined,
          end: rangeParam(range, 1) || undefined,
        })
        setRows(res.items)
        setStats(res.stats)
        setAgents(res.facets?.agents || [])
        setTotal(res.total)
        setLoadError('')
      } catch (e: any) {
        const text = String(e?.message || e)
        setLoadError(text)
        setRows([])
        message.error(text)
      } finally {
        setLoading(false)
      }
    },
    [page, pageSize, q, source, status, agentId, range, message],
  )

  useEffect(() => {
    setPage(1)
    load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, source, status, agentId, range])

  const openDetail = async (r: AgentInvocation) => {
    setDetailLoading(true)
    // 先给个骨架，正文随后补上——网络慢时不至于点下去毫无反应
    setDetail({ ...r, prompt: '', response: '' })
    try {
      const full = await adminInvocationDetail(r.id)
      setDetail(full)
    } catch (e: any) {
      message.error(String(e?.message || e))
    } finally {
      setDetailLoading(false)
    }
  }

  const reset = () => {
    setKw('')
    setQ('')
    setSource(undefined)
    setStatus(undefined)
    setAgentId(undefined)
    setRange(null)
  }

  const hasFilter = !!(q || source || status || agentId != null || range)

  const agentOptions = useMemo(
    () =>
      (agents || []).map((a) => ({
        value: a.id,
        label: `${a.name} (#${a.id} · ${a.type})`,
      })),
    [agents],
  )

  const columns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 168,
      render: (v: string | null) => (
        <Typography.Text style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          {v || '—'}
        </Typography.Text>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      render: (v: string) => <Tag style={{ marginInlineEnd: 0 }}>{INVOCATION_SOURCE_LABELS[v] || v}</Tag>,
    },
    {
      title: 'Agent / 模型',
      dataIndex: 'agent_name',
      width: 200,
      render: (_v: string, r: AgentInvocation) => (
        <div style={{ lineHeight: 1.35 }}>
          <Space size={4}>
            <RobotOutlined style={{ color: '#8f959e' }} />
            <span style={{ fontSize: 13 }}>{r.agent_name || '—'}</span>
            {r.agent_id != null && <Tag color="blue">#{r.agent_id}</Tag>}
          </Space>
          <div style={{ fontSize: 12, color: '#8f959e' }}>
            {r.agent_type || '未知类型'}
            {r.model ? ` · ${r.model}` : ''}
          </div>
        </div>
      ),
    },
    {
      title: '项目 · 需求',
      dataIndex: 'project_name',
      width: 200,
      render: (_v: string, r: AgentInvocation) => (
        <div style={{ lineHeight: 1.35 }}>
          <div style={{ fontSize: 13 }}>
            {r.project_name || (r.project_id != null ? `#${r.project_id}` : '—')}
          </div>
          <div style={{ fontSize: 12, color: '#8f959e' }}>
            {r.requirement_title
              ? `${r.requirement_title}${r.requirement_id != null ? ` (#${r.requirement_id})` : ''}`
              : r.session_id != null
                ? `会话 #${r.session_id}`
                : '—'}
          </div>
        </div>
      ),
    },
    {
      title: '入参 / 出参',
      dataIndex: 'prompt_preview',
      width: 360,
      render: (_v: string, r: AgentInvocation) => (
        <Tooltip
          title={
            <div style={{ maxWidth: 420 }}>
              <div>入参 · {r.prompt_chars} 字</div>
              <div style={{ color: '#c9cdd4' }}>{r.prompt_preview || '（空）'}</div>
              <div style={{ marginTop: 6 }}>出参 · {r.response_chars} 字</div>
              <div style={{ color: '#c9cdd4' }}>{r.response_preview || '（空）'}</div>
            </div>
          }
        >
          <div style={{ fontSize: 12, color: '#646a73', lineHeight: 1.35 }}>
            <div
              style={{
                maxWidth: 420,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.prompt_preview || '（空）'}
            </div>
            <div
              style={{
                color: '#8f959e',
                maxWidth: 420,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.response_preview || '（无输出）'}
            </div>
          </div>
        </Tooltip>
      ),
    },
    {
      title: '结果',
      dataIndex: 'status',
      width: 92,
      render: (_v: string, r: AgentInvocation) => {
        const s = statusOf(r)
        const icon =
          r.status === 'success' ? <CheckCircleOutlined /> : <CloseCircleOutlined />
        return (
          <Tooltip title={s.tip}>
            <Tag color={s.color} icon={icon} style={{ marginInlineEnd: 0 }}>
              {s.label}
            </Tag>
          </Tooltip>
        )
      },
    },
    {
      title: '耗时',
      dataIndex: 'elapsed_ms',
      width: 92,
      render: (v: number) => (
        <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{fmtElapsed(v)}</span>
      ),
    },
    {
      title: 'Token',
      dataIndex: 'total_tokens',
      width: 128,
      render: (_v: number | null, r: AgentInvocation) =>
        r.total_tokens === null || r.total_tokens === undefined ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            未回传
          </Typography.Text>
        ) : (
          <Space size={4}>
            <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
              {fmtTokens(r.total_tokens)}
            </span>
            {r.tokens_estimated ? (
              <Tooltip title="模型未回传用量，此处按字符数估算（仅供参考）">
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                  估
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
        ),
    },
    {
      title: '操作者',
      dataIndex: 'actor',
      width: 150,
      render: (v: string, r: AgentInvocation) => (
        <Space size={4}>
          <Tag color={r.actor_type === 'admin' ? 'purple' : r.actor_type === 'token' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
            {ACTOR_TYPE_LABELS[r.actor_type as keyof typeof ACTOR_TYPE_LABELS] || r.actor_type || '—'}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: v }}>
            {v || ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '',
      key: 'op',
      width: 64,
      render: (_v: unknown, r: AgentInvocation) => (
        <Button type="link" size="small" onClick={() => openDetail(r)}>
          详情
        </Button>
      ),
    },
  ]

  const estRows = stats?.estimated_rows ?? 0

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto' }}>
      <Card styles={{ body: { padding: '20px 24px' } }} style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <Space align="center" size={8}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                Token 审计
              </Typography.Title>
              <Tag color="blue" icon={<ThunderboltOutlined />}>
                {total}
              </Tag>
            </Space>
            <div style={{ color: '#8f959e', fontSize: 13, marginTop: 4 }}>
              每一次 Agent 调用都留痕：入参、出参、项目、需求、模型、Token 用量与耗时；成功与失败都记
            </div>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load()}>
            刷新
          </Button>
        </div>
      </Card>

      {loadError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="调用记录加载失败"
          description={loadError}
        />
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col flex="1 1 160px">
          <Card>
            <Statistic
              title="调用总数"
              value={stats?.total ?? 0}
              valueStyle={{ color: '#3370ff' }}
              prefix={<ThunderboltOutlined />}
            />
          </Card>
        </Col>
        <Col flex="1 1 160px">
          <Card>
            <Statistic
              title="成功"
              value={stats?.success ?? 0}
              valueStyle={{ color: '#00b42a' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col flex="1 1 160px">
          <Card>
            <Statistic
              title="失败"
              value={stats?.error ?? 0}
              valueStyle={{ color: stats?.error ? '#f54a45' : undefined }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col flex="1 1 160px">
          <Card>
            <Statistic
              title="超时 / 限流"
              value={stats?.timed_out ?? 0}
              suffix={`/ ${stats?.rate_limited ?? 0}`}
              prefix={<FieldTimeOutlined />}
            />
          </Card>
        </Col>
        <Col flex="1 1 160px">
          <Card>
            <Statistic
              title="平均耗时"
              value={stats?.avg_elapsed_ms ?? 0}
              suffix="ms"
              prefix={<ClockCircleOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12} lg={8}>
          <Card size="small">
            <Statistic
              title="Token 总量（筛选范围内）"
              value={stats?.total_tokens ?? 0}
              valueStyle={{ fontSize: 22 }}
              suffix={estRows ? <span style={{ fontSize: 12, color: '#ff8800' }}>含 {estRows} 条估算</span> : undefined}
            />
          </Card>
        </Col>
        <Col xs={12} md={6} lg={4}>
          <Card size="small">
            <Statistic title="输入 Token" value={stats?.prompt_tokens ?? 0} valueStyle={{ fontSize: 20 }} />
          </Card>
        </Col>
        <Col xs={12} md={6} lg={4}>
          <Card size="small">
            <Statistic title="输出 Token" value={stats?.completion_tokens ?? 0} valueStyle={{ fontSize: 20 }} />
          </Card>
        </Col>
        <Col xs={12} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="最长耗时"
              value={stats?.max_elapsed_ms ?? 0}
              suffix="ms"
              valueStyle={{ fontSize: 20 }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="工作台会话占比"
              value={
                stats?.total
                  ? Math.round(((stats?.by_source?.session ?? 0) / stats.total) * 100)
                  : 0
              }
              suffix="%"
              valueStyle={{ fontSize: 20 }}
            />
          </Card>
        </Col>
      </Row>

      <Card styles={{ body: { padding: 16 } }}>
        <Space wrap size={8} style={{ marginBottom: 14 }}>
          <Input
            allowClear
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onPressEnter={() => setQ(kw.trim())}
            prefix={<SearchOutlined style={{ color: '#8f959e' }} />}
            placeholder="搜索 Agent、模型、项目、入参、出参…"
            style={{ width: 260 }}
          />
          <Button type="primary" onClick={() => setQ(kw.trim())}>
            搜索
          </Button>

          <Select
            allowClear
            value={source}
            onChange={setSource}
            placeholder="调用来源"
            style={{ width: 140 }}
            options={[
              { value: 'session', label: '工作台会话' },
              { value: 'probe', label: '一键测试' },
              { value: 'ai_cases', label: 'AI 生成用例' },
              { value: 'ai_polish', label: 'AI 润色' },
              { value: 'ai_design', label: 'AI 设计文档' },
            ]}
          />
          <Select
            allowClear
            value={status}
            onChange={setStatus}
            placeholder="结果"
            style={{ width: 110 }}
            options={[
              { value: 'success', label: '成功' },
              { value: 'error', label: '失败' },
            ]}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            value={agentId}
            onChange={setAgentId}
            placeholder="Agent"
            style={{ width: 200 }}
            options={agentOptions}
          />
          <DatePicker.RangePicker
            value={range}
            onChange={(v) => setRange(v as RangeValue)}
            allowEmpty={[true, true]}
            placeholder={['开始日期', '结束日期']}
          />
          <Button
            type="text"
            disabled={!hasFilter}
            onClick={reset}
            style={{ color: hasFilter ? '#3370ff' : undefined }}
          >
            重置筛选
          </Button>
        </Space>

        <Table
          rowKey="id"
          size="small"
          className="tbl-nowrap"
          tableLayout="fixed"
          loading={loading}
          dataSource={rows}
          columns={columns}
          scroll={{ x: 1560 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => {
              // 改每页条数时回到第一页：offset 语义变了，停在原页多半已经越界。
              if (ps !== pageSize) {
                setPageSize(ps)
                setPage(1)
                load(1, ps)
                return
              }
              setPage(p)
              load(p)
            },
          }}
          onRow={(r: AgentInvocation) => ({
            onClick: () => openDetail(r),
            style: { cursor: 'pointer' },
          })}
          locale={{
            emptyText: (
              <Empty
                description={
                  loadError
                    ? '调用记录未加载成功，请检查管理员口令后重试'
                    : hasFilter
                      ? '没有符合筛选条件的调用记录'
                      : '暂无调用记录，Agent 被调起后会实时写入这里'
                }
              />
            ),
          }}
        />
      </Card>

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={720}
        title={
          detail ? (
            <Space size={8}>
              <span>调用详情</span>
              <Tag color="blue">#{detail.id}</Tag>
              <Tag>{INVOCATION_SOURCE_LABELS[detail.source] || detail.source}</Tag>
              <Tag color={statusOf(detail).color}>{statusOf(detail).label}</Tag>
            </Space>
          ) : (
            '调用详情'
          )
        }
      >
        {detail && (
          <Spin spinning={detailLoading}>
            <Descriptions column={2} size="small" styles={{ label: { width: 76 } }}>
              <Descriptions.Item label="时间" span={2}>
                {detail.created_at || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Agent">
                {detail.agent_name || '—'} {detail.agent_id != null ? `#${detail.agent_id}` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="类型">{detail.agent_type || '—'}</Descriptions.Item>
              <Descriptions.Item label="模型">{detail.model || '未配置'}</Descriptions.Item>
              <Descriptions.Item label="操作者">
                {ACTOR_TYPE_LABELS[detail.actor_type as keyof typeof ACTOR_TYPE_LABELS] ||
                  detail.actor_type ||
                  '—'}
                {detail.actor ? ` · ${detail.actor}` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="项目">
                {detail.project_name || (detail.project_id != null ? `#${detail.project_id}` : '—')}
              </Descriptions.Item>
              <Descriptions.Item label="需求">
                {detail.requirement_title ||
                  (detail.requirement_id != null ? `#${detail.requirement_id}` : '—')}
              </Descriptions.Item>
              <Descriptions.Item label="会话">
                {detail.session_id != null ? `#${detail.session_id}` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="事件数">{detail.event_count}</Descriptions.Item>
              <Descriptions.Item label="耗时">{fmtElapsed(detail.elapsed_ms)}</Descriptions.Item>
              <Descriptions.Item label="Token" span={2}>
                {detail.total_tokens === null || detail.total_tokens === undefined ? (
                  '未回传'
                ) : (
                  <Space size={6}>
                    <span>合计 {fmtTokens(detail.total_tokens)}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      输入 {fmtTokens(detail.prompt_tokens)} · 输出 {fmtTokens(detail.completion_tokens)}
                      {detail.tokens_estimated ? '（估算值）' : ''}
                    </Typography.Text>
                  </Space>
                )}
              </Descriptions.Item>
            </Descriptions>

            {detail.error && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 12 }}
                message="失败原因"
                description={
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {detail.error}
                    {detail.timed_out ? '（调用超时）' : ''}
                    {detail.rate_limited ? '（模型限流）' : ''}
                  </span>
                }
              />
            )}

            {[
            // 详情接口不回 *_chars（那是列表接口的摘要字段），这里直接按正文长度算
              { key: 'prompt', label: `入参（${(detail.prompt || '').length} 字）`, text: detail.prompt },
              { key: 'response', label: `出参（${(detail.response || '').length} 字）`, text: detail.response },
            ].map((blk) => (
              <div key={blk.key} style={{ marginTop: 16 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontSize: 13, color: '#646a73' }}>{blk.label}</span>
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    disabled={!blk.text}
                    onClick={() =>
                      copyText(
                        blk.text,
                        () => message.success('已复制到剪贴板'),
                        (m) => message.error(`复制失败：${m}`),
                      )
                    }
                  >
                    复制
                  </Button>
                </div>
                <div
                  style={{
                    padding: 12,
                    background: '#f7f8fa',
                    borderRadius: 8,
                    fontSize: 12,
                    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 320,
                    overflow: 'auto',
                  }}
                >
                  {blk.text || '（空）'}
                </div>
              </div>
            ))}
          </Spin>
        )}
      </Drawer>
    </div>
  )
}
