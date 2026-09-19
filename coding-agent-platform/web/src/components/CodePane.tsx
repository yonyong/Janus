import { Empty, Space, Tag, Timeline } from 'antd'
import { CodeOutlined, FileTextOutlined } from '@ant-design/icons'

/** 编码窗格：Agent 产生的文件改动与 git diff。 */
export default function CodePane({ events }: { events: any[] }) {
  if (events.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="暂无代码改动，Agent 输出后会实时出现在这里"
        style={{ marginTop: 48 }}
      />
    )
  }

  return (
    <Timeline
      items={events.map((e, i) => {
        const p = e.payload || {}
        const path = p.path || e.path || (e.text || '').split('\n')[0]
        return {
          icon: <CodeOutlined style={{ color: '#3370ff', fontSize: 14 }} />,
          content: (
            <div key={i} className="change-item">
              <Space size={6} wrap>
                <Tag icon={<FileTextOutlined />} color="blue" style={{ marginInlineEnd: 0 }}>
                  {path || '改动'}
                </Tag>
                {e.type && <Tag>{e.type}</Tag>}
              </Space>
              {e.text && (
                <div style={{ marginTop: 8, fontSize: 13, whiteSpace: 'pre-wrap' }}>
                  {e.text}
                </div>
              )}
              {e.diff && <pre className="diff">{e.diff}</pre>}
            </div>
          ),
        }
      })}
    />
  )
}
