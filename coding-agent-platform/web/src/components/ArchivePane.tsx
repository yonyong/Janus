import { useEffect, useState } from 'react'
import { App as AntdApp, Alert, Button, Empty, Input, Space, Tag, Typography } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  InboxOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons'
import { CASE_STATUS_LABELS, CaseStatus, TestCase, WorkflowState, archiveRequirement, describeError, syncTestResults } from '../api'
import RichText from './RichText'

const STATUS_META: Record<CaseStatus, { color: string; icon: React.ReactNode }> = {
  passed: { color: '#00b42a', icon: <CheckCircleFilled /> },
  failed: { color: '#f54a45', icon: <CloseCircleFilled /> },
  pending: { color: '#ff9a2e', icon: <ExclamationCircleFilled /> },
  skipped: { color: '#8f959e', icon: <MinusCircleOutlined /> },
}

/**
 * 归档验收：一屏测试报告（每条用例的执行结果汇总）+ 一键「标记需求已完成」。
 * 不再罗列需求文档 / 改动文件 / 会话记录 —— 那些在各自阶段里都看得到，
 * 这一步只回答一个问题：测得怎么样？这个需求完成了吗？
 */
export default function ArchivePane({
  token,
  rid,
  flow,
  cases,
  onReload,
}: {
  token: string | null
  rid: number | null
  flow: WorkflowState | null
  cases: TestCase[]
  onReload: (silent?: boolean) => void | Promise<void>
}) {
  const { message } = AntdApp.useApp()
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setNote(flow?.verdict_note || '')
  }, [rid, flow?.verdict_note])

  const stats = flow?.cases

  // 进归档先同步一次测试报告：Agent 只写工作区的 test-result.md，页面统计读的是
  // 库里的用例状态；不同步的话 Agent 说 30/30 全过、这里仍显示 0/30。
  // 同步失败静默（报告没写 / 格式不对都是正常状态），别挡住归档页本身。
  useEffect(() => {
    if (rid === null) return
    let alive = true
    syncTestResults(token, rid)
      .then((r) => {
        if (!alive) return
        if (r.updated > 0) {
          message.info(`已从测试报告同步 ${r.updated} 条用例结果`)
          void onReload(true)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // token/message/onReload 不随 rid 变化，只按需求触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, token])

  const blocking = (stats?.pending || 0) + (stats?.failed || 0)
  const archived = flow?.stage === 'archive' && !!flow?.archived_at
  const total = stats?.total ?? 0

  const submit = async () => {
    if (rid === null) return
    setSaving(true)
    try {
      await archiveRequirement(token, rid, 'accepted', note)
      await onReload(true)
      message.success(
        blocking > 0
          ? `已标记：需求已完成（注意：还有 ${blocking} 条用例未通过/未验证）`
          : '已标记：需求已完成',
      )
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setSaving(false)
    }
  }

  if (!flow) {
    return (
      <div className="archive-pane">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" style={{ marginTop: 48 }} />
      </div>
    )
  }

  return (
    <div className="archive-pane">
      {archived && (
        <Alert
          type={flow.verdict === 'accepted' ? 'success' : 'warning'}
          showIcon
          style={{ margin: '0 10px 8px' }}
          message={
            flow.verdict === 'accepted'
              ? `已于 ${String(flow.archived_at).replace('T', ' ')} 标记完成`
              : `已于 ${String(flow.archived_at).replace('T', ' ')} 记录打回`
          }
          description={flow.verdict_note ? <RichText text={flow.verdict_note} /> : undefined}
        />
      )}

      <div className="arc-scroll">
        {/* 弱提示不阻断：没配用例也能归档，但要把「验收依据是什么」说清楚 */}
        {!archived && total === 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ margin: '0 10px 8px' }}
            message={
              flow.requirement?.mode === 'lite'
                ? '轻量流程：本需求未配置用例，验收依据以改动记录与对话结论为准'
                : '本需求未配置用例，验收依据以改动记录与对话结论为准'
            }
            description='仍可直接标记完成；如需用例佐证，可到「用例配置」补配后再归档。'
          />
        )}
        <div className="arc-card">
          <div className="arc-card-head">
            <Space size={8}>
              <span className="arc-head-title">测试报告</span>
              <span className="arc-head-sub">
                {total === 0
                  ? '还没有可执行的用例'
                  : blocking === 0
                    ? `${total} 条用例全部通过 ✨`
                    : `${stats?.passed ?? 0} / ${total} 条通过`}
              </span>
            </Space>
            <Space size={4} wrap>
              <Tag color="green" style={{ marginInlineEnd: 0 }}>
                通过 {stats?.passed ?? 0}
              </Tag>
              <Tag color={(stats?.failed ?? 0) > 0 ? 'red' : 'default'} style={{ marginInlineEnd: 0 }}>
                失败 {stats?.failed ?? 0}
              </Tag>
              <Tag style={{ marginInlineEnd: 0 }}>未跑 {(stats?.pending ?? 0) + (stats?.skipped ?? 0)}</Tag>
              {(stats?.manual_pending ?? 0) > 0 && (
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  人工待核 {stats?.manual_pending}
                </Tag>
              )}
            </Space>
          </div>

          {total > 0 && (
            <div className="arc-bar" aria-hidden>
              <span className="arc-bar-seg" style={{ flex: stats?.passed || 0.0001, background: '#00b42a' }} />
              <span className="arc-bar-seg" style={{ flex: stats?.failed || 0.0001, background: '#f54a45' }} />
              <span
                className="arc-bar-seg"
                style={{
                  flex: (stats?.pending || 0) + (stats?.skipped || 0) || 0.0001,
                  background: 'linear-gradient(90deg,#ff9a2e,#c9cdd4)',
                }}
              />
            </div>
          )}

          <div className="arc-card-body">
            {cases.length === 0 ? (
              <Typography.Text type="secondary">
                这个需求还没有配置用例。回到「用例配置」配好后，编码 Agent 执行的结果会汇总到这里。
              </Typography.Text>
            ) : (
              <div className="arc-cases">
                {cases.map((c, i) => (
                  <div className={`arc-case arc-case-${c.status}`} key={c.id}>
                    <span className="arc-case-no">{String(i + 1).padStart(2, '0')}</span>
                    <span
                      className="arc-case-icon"
                      style={{ color: STATUS_META[c.status].color }}
                      title={CASE_STATUS_LABELS[c.status]}
                    >
                      {STATUS_META[c.status].icon}
                    </span>
                    <span className="arc-case-title">{c.title}</span>
                    {c.note && c.status === 'failed' && (
                      <span className="arc-case-note" title={c.note}>
                        {c.note}
                      </span>
                    )}
                    <Tag style={{ marginInlineEnd: 0, flex: 'none' }}>{CASE_STATUS_LABELS[c.status]}</Tag>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="arc-verdict">
        <Input.TextArea
          className="arc-note"
          rows={2}
          value={note}
          placeholder="备注（可选：遗留问题、后续跟进项）"
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="arc-actions">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {archived
              ? '已标记为完成；如需继续修改，可切回「用例配置」或「编码实现」阶段（会自动撤销标记）。'
              : blocking > 0
                ? `还有 ${blocking} 条用例未通过/未验证，仍可直接标记完成。`
                : '标记完成后，这个需求就算交付完毕。'}
          </Typography.Text>
          <Space size={8}>
            <Button
              type="primary"
              icon={<InboxOutlined />}
              loading={saving}
              onClick={submit}
              disabled={rid === null || archived}
            >
              {archived ? '已完成' : '标记需求已完成'}
            </Button>
          </Space>
        </div>
      </div>
    </div>
  )
}
