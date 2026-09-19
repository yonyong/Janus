import { Card, Empty, Space, Statistic, Tag, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, ConsoleSqlOutlined } from '@ant-design/icons'

/** 测试窗格：Agent 自报的测试命令与结果。 */
export default function TestPane({ events }: { events: any[] }) {
  if (events.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="暂无测试结果"
        style={{ marginTop: 48 }}
      />
    )
  }

  const passed = events.filter((e) => (e.payload || {}).passed).length

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12, background: '#fafbfc' }}>
        <Space size={40}>
          <Statistic title="执行" value={events.length} valueStyle={{ fontSize: 20 }} />
          <Statistic
            title="通过"
            value={passed}
            valueStyle={{ fontSize: 20, color: '#00b42a' }}
          />
          <Statistic
            title="失败"
            value={events.length - passed}
            valueStyle={{ fontSize: 20, color: '#f54a45' }}
          />
        </Space>
      </Card>

      {events.map((e, i) => {
        const p = e.payload || {}
        const ok = !!p.passed
        return (
          <div className="change-item" key={i}>
            <Space size={8} align="center" wrap>
              {ok ? (
                <CheckCircleOutlined style={{ color: '#00b42a' }} />
              ) : (
                <CloseCircleOutlined style={{ color: '#f54a45' }} />
              )}
              <Tag color={ok ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>
                {ok ? '通过' : '失败'}
              </Tag>
              <Typography.Text code style={{ fontSize: 12 }}>
                <ConsoleSqlOutlined /> {p.cmd || e.text || '—'}
              </Typography.Text>
            </Space>
            {p.output && <pre className="diff diff-test">{p.output}</pre>}
          </div>
        )
      })}
    </div>
  )
}
