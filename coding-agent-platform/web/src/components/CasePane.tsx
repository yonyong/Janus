import { useEffect, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import {
  TestCase,
  Attachment,
  batchDeleteCases,
  deleteAttachment,
  describeError,
  createCase,
  deleteCase,
  listAttachments,
  updateCase,
  uploadCaseAttachments,
} from '../api'
import RichText from './RichText'

interface DraftState {
  mode: 'create' | 'edit'
  id?: number
  title: string
  steps: string
  expected: string
  note: string
}

/**
 * 用例配置：左侧是用例本身（标题 / 步骤 / 预期 / 附件，支持勾选批量删除），
 * 不掺验证结果（通过与否是编码实现跑完单测后、归档验收测试报告里看的事）；
 * 右侧是对话（与需求澄清同款），快捷指令让 Agent 生成用例草稿写入工作区，
 * 对话结束后平台自动把草稿导入用例列表（同名条目跳过），流式输出没有超时上限。
 * 配好的用例会导出到项目工作区 .janus/ 下，编码 Agent 按它执行单测。
 */
export default function CasePane({
  token,
  rid,
  cases,
  loading,
  onReload,
  onAskAgent,
}: {
  token: string | null
  rid: number | null
  cases: TestCase[]
  loading: boolean
  onReload: (silent?: boolean) => void | Promise<void>
  /** 提供时，空态里直接给「一键生成用例」主按钮（走右侧对话的快捷指令同款链路）。 */
  onAskAgent?: () => void
}) {
  const { message, modal } = AntdApp.useApp()
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<number[]>([])
  // 批量删除：勾选中的用例 id
  const [selected, setSelected] = useState<number[]>([])
  const [deleting, setDeleting] = useState(false)
  // 用例附件：case_id -> 附件列表；附件实体在项目工作区 .janus/ 下
  const [atts, setAtts] = useState<Record<number, Attachment[]>>({})
  const [attsUploading, setAttsUploading] = useState<number | null>(null)

  useEffect(() => {
    setDraft(null)
    setAtts({})
    setSelected([])
  }, [rid])

  // 列表刷新后剔除已不存在的勾选项，避免幽灵勾选
  useEffect(() => {
    setSelected((sel) => sel.filter((id) => cases.some((c) => c.id === id)))
  }, [cases])

  const loadAtts = async (silent = false) => {
    if (rid === null) return
    try {
      const rows = await listAttachments(token, rid)
      const map: Record<number, Attachment[]> = {}
      for (const a of rows) {
        if (a.case_id) (map[a.case_id] ||= []).push(a)
      }
      setAtts(map)
    } catch (e) {
      if (!silent) {
        const info = describeError(e)
        message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
      }
    }
  }

  useEffect(() => {
    void loadAtts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, token])

  const uploadAtts = async (cid: number, files: File[]) => {
    if (!files.length) return
    setAttsUploading(cid)
    try {
      await uploadCaseAttachments(token, cid, files)
      message.success('附件已上传，编码 Agent 执行该用例时会读到')
      await loadAtts(true)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setAttsUploading(null)
    }
  }

  const removeAtt = async (a: Attachment) => {
    try {
      await deleteAttachment(token, a.id)
      await loadAtts(true)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    }
  }

  const submitDraft = async () => {
    if (!draft || rid === null) return
    if (!draft.title.trim()) return message.warning('用例标题不能为空')
    setSaving(true)
    try {
      if (draft.mode === 'edit' && draft.id) {
        await updateCase(token, draft.id, {
          title: draft.title.trim(),
          steps: draft.steps,
          expected: draft.expected,
          note: draft.note,
        })
      } else {
        await createCase(token, rid, {
          title: draft.title.trim(),
          steps: draft.steps,
          expected: draft.expected,
          status: 'pending',
        })
      }
      setDraft(null)
      await onReload(true)
      message.success('已保存用例')
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = (c: TestCase) => {
    modal.confirm({
      title: `删除用例「${c.title}」？`,
      content: '删除后不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteCase(token, c.id)
          await onReload(true)
        } catch (e) {
          const info = describeError(e)
          message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
        }
      },
    })
  }

  const confirmBatchDelete = () => {
    if (!selected.length) return
    const n = selected.length
    modal.confirm({
      title: `删除选中的 ${n} 条用例？`,
      content: '删除后不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeleting(true)
        try {
          const r = await batchDeleteCases(token, selected)
          setSelected([])
          await onReload(true)
          message.success(`已删除 ${r.deleted} 条用例`)
        } catch (e) {
          const info = describeError(e)
          message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
        } finally {
          setDeleting(false)
        }
      },
    })
  }

  const toggleOne = (id: number, checked: boolean) =>
    setSelected((sel) => (checked ? [...new Set([...sel, id])] : sel.filter((x) => x !== id)))

  const allPicked = cases.length > 0 && selected.length === cases.length
  const somePicked = selected.length > 0 && selected.length < cases.length

  return (
    <div className="case-pane">
      <div className="case-head">
        <div className="case-head-text">
          <span className="case-head-title">测试用例</span>
          <span className="case-head-sub">
            共 {cases.length} 条 · 配好的用例会导出给编码 Agent 逐条执行
          </span>
        </div>
        {cases.length > 0 && (
          <Checkbox
            checked={allPicked}
            indeterminate={somePicked}
            onChange={(e) => setSelected(e.target.checked ? cases.map((c) => c.id) : [])}
          >
            全选
          </Checkbox>
        )}
      </div>

      <div className="case-actions">
        <Space size={6} wrap>
          <Button
            size="small"
            icon={<PlusOutlined />}
            disabled={rid === null}
            onClick={() => setDraft({ mode: 'create', title: '', steps: '', expected: '', note: '' })}
          >
            新增用例
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={selected.length === 0}
            loading={deleting}
            onClick={confirmBatchDelete}
          >
            删除选中{selected.length > 0 ? `（${selected.length}）` : ''}
          </Button>
          <Tooltip title="刷新用例列表">
            <Button size="small" type="text" icon={<ReloadOutlined spin={loading} />} onClick={() => onReload()} />
          </Tooltip>
        </Space>
      </div>

      <div className="case-list">
        {loading && cases.length === 0 ? (
          <div style={{ padding: '4px 2px' }}>
            <Skeleton active title={false} paragraph={{ rows: 2 }} />
            <Skeleton active title={false} paragraph={{ rows: 2 }} />
            <Skeleton active title={false} paragraph={{ rows: 1 }} />
          </div>
        ) : cases.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有用例：让 Agent 通读需求与设计自动生成，或手动新增"
            style={{ marginTop: 40 }}
          >
            {onAskAgent && rid !== null && (
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={onAskAgent}>
                一键生成用例
              </Button>
            )}
          </Empty>
        ) : (
          cases.map((c, i) => {
            const expanded = open.includes(c.id)
            const hasDetail = !!(c.steps || c.expected || c.note || (atts[c.id] || []).length)
            const picked = selected.includes(c.id)
            return (
              <div
                className={`case-row${expanded ? ' is-open' : ''}${picked ? ' is-picked' : ''}`}
                key={c.id}
                style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}
              >
                <div
                  className="case-row-head"
                  onClick={() => hasDetail && setOpen((o) => (expanded ? o.filter((x) => x !== c.id) : [...o, c.id]))}
                >
                  <span className="case-pick" onClick={(ev) => ev.stopPropagation()}>
                    <Checkbox
                      checked={picked}
                      onChange={(e) => toggleOne(c.id, e.target.checked)}
                    />
                  </span>

                  <span className={`case-caret${hasDetail ? '' : ' is-hidden'}`}>
                    <RightOutlined rotate={expanded ? 90 : 0} />
                  </span>

                  <span className="case-title">
                    <span className="case-title-no">{String(i + 1).padStart(2, '0')}</span>
                    <span className="case-title-text" title={c.title}>
                      {c.title}
                    </span>
                  </span>

                  <span className="case-flags">
                    {c.source === 'ai' && (
                      <Tag color="purple" className="case-flag">
                        AI
                      </Tag>
                    )}
                    {c.note && (
                      <Tag className="case-flag">有备注</Tag>
                    )}
                  </span>

                  <span className="case-ops" onClick={(ev) => ev.stopPropagation()}>
                    <Tooltip title="编辑">
                      <Button
                        size="small"
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() =>
                          setDraft({
                            mode: 'edit',
                            id: c.id,
                            title: c.title,
                            steps: c.steps,
                            expected: c.expected,
                            note: c.note,
                          })
                        }
                      />
                    </Tooltip>
                    <Tooltip title="删除">
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => confirmDelete(c)}
                      />
                    </Tooltip>
                  </span>
                </div>

                {expanded && (
                  <div className="case-detail">
                    <div className="case-field">
                      <span className="case-label">
                        <FileTextOutlined /> 步骤
                      </span>
                      <div className="case-field-body">
                        <RichText text={c.steps || '（未填写）'} />
                      </div>
                    </div>
                    <div className="case-field">
                      <span className="case-label">
                        <CheckCircleOutlined /> 预期
                      </span>
                      <div className="case-field-body">
                        <RichText text={c.expected || '（未填写）'} />
                      </div>
                    </div>
                    {c.note && (
                      <div className="case-field">
                        <span className="case-label">
                          <EditOutlined /> 备注
                        </span>
                        <div className="case-field-body">
                          <RichText text={c.note} />
                        </div>
                      </div>
                    )}
                    <div className="case-field">
                      <span className="case-label">
                        <PaperClipOutlined /> 附件
                      </span>
                      <div className="case-field-body">
                        <div className="case-atts">
                          {(atts[c.id] || []).map((a) => (
                            <span className="case-att" key={a.id} title={a.path}>
                              <PaperClipOutlined />
                              <span className="case-att-name">{a.filename}</span>
                              <Button
                                size="small"
                                type="text"
                                danger
                                icon={<DeleteOutlined />}
                                onClick={() => void removeAtt(a)}
                              />
                            </span>
                          ))}
                          <Upload
                            multiple
                            showUploadList={false}
                            customRequest={({ file }) => void uploadAtts(c.id, [file as File])}
                          >
                            <Button size="small" icon={<PlusOutlined />} loading={attsUploading === c.id}>
                              上传附件
                            </Button>
                          </Upload>
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          附件存入项目目录，并写入用例清单供编码 Agent 执行时参考
                        </Typography.Text>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 新增 / 编辑用例 */}
      <Modal
        title={draft?.mode === 'edit' ? '编辑用例' : '新增用例'}
        open={!!draft}
        onCancel={() => setDraft(null)}
        onOk={submitDraft}
        confirmLoading={saving}
        okText="保存"
        width={620}
        destroyOnHidden
      >
        {draft && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Input
              autoFocus
              placeholder="用例标题，例如：密码错误 5 次后锁定 10 分钟"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <Input.TextArea
              rows={4}
              placeholder="操作步骤（多步换行）"
              value={draft.steps}
              onChange={(e) => setDraft({ ...draft, steps: e.target.value })}
            />
            <Input.TextArea
              rows={3}
              placeholder="预期结果"
              value={draft.expected}
              onChange={(e) => setDraft({ ...draft, expected: e.target.value })}
            />
            {draft.mode === 'edit' && (
              <Input.TextArea
                rows={2}
                placeholder="备注（补充说明、复现链接等）"
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            )}
            {draft.mode === 'create' && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                也可以先在右侧对话里让 Agent 生成用例，结束后会自动导入到这里。
              </Typography.Text>
            )}
          </Space>
        )}
      </Modal>
    </div>
  )
}
