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
  FolderOutlined,
  HistoryOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import {
  ACTOR_TYPE_LABELS,
  AuditFacet,
  AuditLog,
  AuditStats,
  adminAuditLogs,
  auditActionLabel,
  auditCategoryLabel,
} from '../api'

/** 分页：默认 10 条/页，可在分页器里调整为 10/20/50/100。 */
const DEFAULT_PAGE_SIZE = 10
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

type RangeValue = [Dayjs | null, Dayjs | null] | null

/** 日期区间 → 接口要的 `YYYY-MM-DD`；只填一端也允许。 */
const rangeParam = (r: RangeValue, idx: 0 | 1): string => {
  const d = r?.[idx]
  return d ? d.format('YYYY-MM-DD') : ''
}

/** detail 是 JSON 串，能解析就格式化展示，解析不了原样给出（不要把内容吞掉）。 */
function prettyDetail(detail: string): string {
  const t = (detail || '').trim()
  if (!t) return ''
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return t
  }
}

const ACTOR_ICON: Record<string, string> = {
  admin: 'purple',
  token: 'blue',
  anonymous: 'default',
}

export default function AuditLogs() {
  const { message } = AntdApp.useApp()

  const [rows, setRows] = useState<AuditLog[]>([])
  const [stats, setStats] = useState<AuditStats | null>(null)
  const [facets, setFacets] = useState<{ categories: AuditFacet[]; actions: AuditFacet[] }>({
    categories: [],
    actions: [],
  })
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  // 关键词：输入与「已提交」分开，避免每敲一个字就打一次接口。
  const [kw, setKw] = useState('')
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string | undefined>()
  const [action, setAction] = useState<string | undefined>()
  const [status, setStatus] = useState<string | undefined>()
  const [actorType, setActorType] = useState<string | undefined>()
  const [range, setRange] = useState<RangeValue>(null)

  const [detail, setDetail] = useState<AuditLog | null>(null)

  const load = useCallback(
    async (targetPage = page, size = pageSize) => {
      setLoading(true)
      try {
        const res = await adminAuditLogs({
          limit: size,
          offset: (targetPage - 1) * size,
          q: q || undefined,
          category,
          action,
          status,
          actor_type: actorType,
          start: rangeParam(range, 0) || undefined,
          end: rangeParam(range, 1) || undefined,
        })
        setRows(res.items)
        setStats(res.stats)
        setFacets(res.facets || { categories: [], actions: [] })
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
    [page, pageSize, q, category, action, status, actorType, range, message],
  )

  // 任一筛选条件变化都回到第一页：否则会停在「第 3 页」看到空表，像坏了。
  useEffect(() => {
    setPage(1)
    load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, action, status, actorType, range])

  const reset = () => {
    setKw('')
    setQ('')
    setCategory(undefined)
    setAction(undefined)
    setStatus(undefined)
    setActorType(undefined)
    setRange(null)
  }

  const categoryOptions = useMemo(
    () =>
      (facets.categories || []).map((f) => ({
        value: f.value,
        label: `${auditCategoryLabel(f.value)} (${f.count})`,
      })),
    [facets.categories],
  )

  const actionOptions = useMemo(
    () =>
      (facets.actions || []).map((f) => ({
        value: f.value,
        label: `${auditActionLabel(f.value)} (${f.count})`,
      })),
    [facets.actions],
  )

  const hasFilter = !!(q || category || action || status || actorType || range)

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
      title: '操作者',
      dataIndex: 'actor',
      width: 180,
      render: (_v: string, r: AuditLog) => (
        <Space size={6}>
          <Tag color={ACTOR_ICON[r.actor_type] || 'default'} style={{ marginInlineEnd: 0 }}>
            {ACTOR_TYPE_LABELS[r.actor_type] || r.actor_type}
          </Tag>
          <Typography.Text style={{ fontSize: 12, color: '#646a73' }} ellipsis={{ tooltip: r.actor }}>
            {r.token_id ? `#${r.token_id} ` : ''}
            {r.actor || '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '操作',
      dataIndex: 'action',
      width: 190,
      render: (v: string, r: AuditLog) => (
        <Space size={6}>
          <Tag style={{ marginInlineEnd: 0 }}>{auditCategoryLabel(r.category)}</Tag>
          <span style={{ fontSize: 13 }}>{auditActionLabel(v)}</span>
        </Space>
      ),
    },
    {
      title: '操作对象',
      dataIndex: 'target_name',
      width: 220,
      ellipsis: true,
      render: (_v: string, r: AuditLog) => (
        <Space size={6}>
          {r.target_id != null && <Tag color="blue">#{r.target_id}</Tag>}
          <span style={{ fontSize: 13 }}>{r.target_name || r.target_type || '—'}</span>
        </Space>
      ),
    },
    {
      title: '项目',
      dataIndex: 'project_name',
      width: 160,
      render: (v: string, r: AuditLog) =>
        v ? (
          <Space size={4}>
            <FolderOutlined style={{ color: '#8f959e' }} />
            <span style={{ fontSize: 13 }}>{v}</span>
          </Space>
        ) : r.project_id != null ? (
          <Tag color="blue">#{r.project_id}</Tag>
        ) : (
          <span style={{ color: '#c9cdd4' }}>—</span>
        ),
    },
    {
      title: '结果',
      dataIndex: 'status',
      width: 150,
      render: (v: string, r: AuditLog) =>
        v === 'failure' ? (
          <Tooltip title={r.error || '未记录失败原因'}>
            <Tag color="error" icon={<CloseCircleOutlined />} style={{ marginInlineEnd: 0 }}>
              失败
            </Tag>
          </Tooltip>
        ) : (
          <Tag color="success" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
            成功
          </Tag>
        ),
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      width: 130,
      render: (v: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {v || '—'}
        </Typography.Text>
      ),
    },
    {
      title: '',
      key: 'op',
      width: 64,
      render: (_v: unknown, r: AuditLog) => (
        <Button type="link" size="small" onClick={() => setDetail(r)}>
          详情
        </Button>
      ),
    },
  ]

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
                操作日志
              </Typography.Title>
              <Tag color="blue" icon={<HistoryOutlined />}>
                {total}
              </Tag>
            </Space>
            <div style={{ color: '#8f959e', fontSize: 13, marginTop: 4 }}>
              项目、令牌、Agent、需求、文件与回退等敏感操作全部留痕，成功与失败都记
            </div>
          </div>
          <Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load()}>
              刷新
            </Button>
          </Space>
        </div>
      </Card>

      {loadError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="日志加载失败"
          description={loadError}
        />
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col flex="1 1 160px">
          <Card>
            <Statistic title="记录总数" value={stats?.total ?? 0} valueStyle={{ color: '#3370ff' }} />
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
              value={stats?.failure ?? 0}
              valueStyle={{ color: stats?.failure ? '#f54a45' : undefined }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col flex="1 1 160px">
          <Card>
            <Statistic
              title="今日"
              value={stats?.today ?? 0}
              prefix={<ClockCircleOutlined />}
            />
          </Card>
        </Col>
        <Col flex="1 1 160px">
          <Card>
            <Statistic
              title="涉及项目"
              value={stats?.projects ?? 0}
              prefix={<FolderOutlined />}
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
            placeholder="搜索操作、对象、项目、IP、详情…"
            style={{ width: 260 }}
          />
          <Button type="primary" onClick={() => setQ(kw.trim())}>
            搜索
          </Button>

          <Select
            allowClear
            value={category}
            onChange={setCategory}
            placeholder="分类"
            style={{ width: 132 }}
            options={categoryOptions}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            value={action}
            onChange={setAction}
            placeholder="具体操作"
            style={{ width: 190 }}
            options={actionOptions}
          />
          <Select
            allowClear
            value={status}
            onChange={setStatus}
            placeholder="结果"
            style={{ width: 110 }}
            options={[
              { value: 'success', label: '成功' },
              { value: 'failure', label: '失败' },
            ]}
          />
          <Select
            allowClear
            value={actorType}
            onChange={setActorType}
            placeholder="身份"
            style={{ width: 118 }}
            options={[
              { value: 'admin', label: '管理员' },
              { value: 'token', label: '访问令牌' },
              { value: 'anonymous', label: '匿名' },
            ]}
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
          scroll={{ x: 1252 }}
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
          onRow={(r: AuditLog) => ({
            onClick: () => setDetail(r),
            style: { cursor: 'pointer' },
          })}
          locale={{
            emptyText: (
              <Empty
                description={
                  loadError
                    ? '日志未加载成功，请检查管理员口令后重试'
                    : hasFilter
                      ? '没有符合筛选条件的操作记录'
                      : '暂无操作记录，敏感操作发生后会实时写入这里'
                }
              />
            ),
          }}
        />
      </Card>

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={620}
        title={
          detail ? (
            <Space size={8}>
              <span>{auditActionLabel(detail.action)}</span>
              <Tag color="blue">#{detail.id}</Tag>
              {detail.status === 'failure' ? (
                <Tag color="error">失败</Tag>
              ) : (
                <Tag color="success">成功</Tag>
              )}
            </Space>
          ) : (
            '操作详情'
          )
        }
      >
        {detail && (
          <>
            <Descriptions column={1} size="small" styles={{ label: { width: 88 } }}>
              <Descriptions.Item label="时间">{detail.created_at || '—'}</Descriptions.Item>
              <Descriptions.Item label="操作者">
                <Space size={6}>
                  <Tag color={ACTOR_ICON[detail.actor_type] || 'default'}>
                    {ACTOR_TYPE_LABELS[detail.actor_type] || detail.actor_type}
                  </Tag>
                  <span>{detail.actor || '—'}</span>
                  {detail.token_id != null && <Tag color="blue">令牌 #{detail.token_id}</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="来源 IP">{detail.ip || '—'}</Descriptions.Item>
              <Descriptions.Item label="分类">
                {auditCategoryLabel(detail.category)}
              </Descriptions.Item>
              <Descriptions.Item label="操作对象">
                {detail.target_type || '—'} {detail.target_id != null ? `#${detail.target_id}` : ''}{' '}
                {detail.target_name || ''}
              </Descriptions.Item>
              <Descriptions.Item label="所属项目">
                {detail.project_name || (detail.project_id != null ? `#${detail.project_id}` : '—')}
              </Descriptions.Item>
            </Descriptions>

            {detail.error && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 12 }}
                message="失败原因"
                description={detail.error}
              />
            )}

            <div style={{ marginTop: 16, fontSize: 13, color: '#646a73' }}>操作详情</div>
            <div
              style={{
                marginTop: 6,
                padding: 12,
                background: '#f7f8fa',
                borderRadius: 8,
                fontSize: 12,
                fontFamily:
                  "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 420,
                overflow: 'auto',
              }}
            >
              {prettyDetail(detail.detail) || '（无额外详情）'}
            </div>
          </>
        )}
      </Drawer>
    </div>
  )
}
