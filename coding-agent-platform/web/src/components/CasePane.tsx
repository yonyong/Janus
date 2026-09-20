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
  CloseCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  PaperClipOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  ThunderboltOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import {
  TestCase,
  Attachment,
  AcceptScriptStatus,
  acceptScriptStatus,
  batchDeleteCases,
  deleteAttachment,
  describeError,
  createCase,
  deleteCase,
  listAttachments,
  runAcceptScript,
  updateCase,
  uploadCaseAttachments,
} from '../api'
import { acceptGeneratePrompt } from './FlowCommands'
import RichText from './RichText'

interface DraftState {
  mode: 'create' | 'edit'
  id?: number
  title: string
  steps: string
  expected: string
  note: string
  is_manual?: boolean
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  passed: { color: 'green', label: '通过' },
  failed: { color: 'red', label: '失败' },
  skipped: { color: 'default', label: '跳过' },
  pending: { color: 'gold', label: '待验证' },
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
  dir,
  cases,
  loading,
  onReload,
  onAskAgent,
  onUseCommand,
  onOpenFiles,
  refreshSignal = 0,
}: {
  token: string | null
  rid: number | null
  /** 需求目录名（.janus/{dir}/…），用于总验收脚本指令与提示。 */
  dir: string
  cases: TestCase[]
  loading: boolean
  onReload: (silent?: boolean) => void | Promise<void>
  /** 提供时，空态里直接给「一键生成用例」主按钮（走右侧对话的快捷指令同款链路）。 */
  onAskAgent?: () => void
  /** 把话术填入右侧对话输入框（生成/更新验收脚本用）。 */
  onUseCommand?: (text: string) => void
  /** 跳到「项目文件」分类（打开脚本用）。 */
  onOpenFiles?: () => void
  /** Agent 产出改动时递增：用于刷新脚本状态（脚本可能刚被写出/更新）。 */
  refreshSignal?: number
}) {
  const { message, modal } = AntdApp.useApp()
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<number[]>([])
  // 批量删除：勾选中的用例 id
  const [selected, setSelected] = useState<number[]>([])
  const [deleting, setDeleting] = useState(false)
  // 总验收脚本状态 + 执行态；仅人工核对筛选
  const [script, setScript] = useState<AcceptScriptStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [manualOnly, setManualOnly] = useState(false)
  const [runOut, setRunOut] = useState<{ title: string; body: string } | null>(null)
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

  // 总验收脚本状态：进入 / 用例变化 / Agent 改动后刷新
  const loadScript = async () => {
    if (rid === null) return
    try {
      setScript(await acceptScriptStatus(token, rid))
    } catch {
      /* 脚本状态属锦上添花，拉取失败不打断用例配置 */
    }
  }
  useEffect(() => {
    void loadScript()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, token, cases.length, refreshSignal])

  // 执行总验收：跑脚本 → 平台 sync 回写用例红绿（验收主路径，不依赖 AI 临场想测法）
  const runAcceptance = async () => {
    if (rid === null || running) return
    setRunning(true)
    try {
      const r = await runAcceptScript(token, rid)
      if (!r.ran) {
        if (r.reason === 'no_script') {
          message.warning('还没有总验收脚本：请先点「生成/更新验收脚本」让 Agent 写一份')
        } else if (r.reason === 'interpreter_missing') {
          message.error(`脚本解释器缺失（${r.lang || ''}）：${r.detail || ''}`)
        } else if (r.reason === 'timeout') {
          message.error(`脚本执行超时（${r.timeout}s）`)
        } else {
          message.error(`脚本未能执行：${r.reason || '未知原因'}`)
        }
        return
      }
      const updated = r.sync?.updated ?? 0
      const ok = r.exit_code === 0
      message[ok ? 'success' : 'warning'](
        `验收脚本已执行（退出码 ${r.exit_code}）` +
          (r.sync?.found ? `，回写 ${updated} 条用例结果` : '，但未找到测试报告'),
      )
      setRunOut({
        title: `执行验收 · ${r.entry}（退出码 ${r.exit_code}）`,
        body: r.output || '（脚本无输出）',
      })
      await onReload(true)
      await loadScript()
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setRunning(false)
    }
  }

  const generateScript = () => {
    if (!onUseCommand) {
      message.info('请在右侧对话里让 Agent 生成/更新总验收脚本')
      return
    }
    onUseCommand(acceptGeneratePrompt(dir))
    message.info('已把「生成/更新验收脚本」指令填入右侧对话，确认后发送')
  }

  // 人工项快速勾选结果（通过/失败）
  const markManual = async (c: TestCase, status: 'passed' | 'failed') => {
    try {
      await updateCase(token, c.id, { status })
      await onReload(true)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    }
  }

  const toggleManual = async (c: TestCase, isManual: boolean) => {
    try {
      await updateCase(token, c.id, { is_manual: isManual })
      await onReload(true)
      await loadScript()
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    }
  }

  const coveredIds = new Set(script?.coverage?.covered_ids ?? [])
  const uncoveredIds = new Set(script?.coverage?.uncovered_ids ?? [])

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
          is_manual: !!draft.is_manual,
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

      {/* 主操作：验收主路径固定醒目 —— 生成脚本 / 跑脚本 / 人工核对 */}
      <div className="case-accept">
        <div className="case-accept-actions">
          <Button
            type="primary"
            size="small"
            icon={<CodeOutlined />}
            disabled={rid === null}
            onClick={generateScript}
          >
            {script?.exists ? '更新验收脚本' : '生成验收脚本'}
          </Button>
          <Button
            size="small"
            icon={<PlayCircleOutlined />}
            loading={running}
            disabled={rid === null}
            onClick={() => void runAcceptance()}
          >
            执行验收
          </Button>
          <Button
            size="small"
            type={manualOnly ? 'primary' : 'default'}
            ghost={manualOnly}
            icon={<UserOutlined />}
            disabled={rid === null}
            onClick={() => setManualOnly((v) => !v)}
          >
            仅人工核对{(script && cases.some((c) => c.is_manual)) ? '' : ''}
          </Button>
        </div>
        <div className="case-accept-status">
          {!script?.exists ? (
            <span className="case-script-chip is-none">
              <WarningOutlined /> 无脚本
            </span>
          ) : script.stale ? (
            <Tooltip title="用例在脚本生成后有变更，建议重新「更新验收脚本」">
              <span className="case-script-chip is-stale">
                <WarningOutlined /> 用例已变，请更新脚本
              </span>
            </Tooltip>
          ) : (
            <span className="case-script-chip is-ok">
              <CheckCircleOutlined /> 已生成 · {script.mtime?.slice(5, 16)}
            </span>
          )}
          {script?.exists && (
            <Button size="small" type="link" onClick={() => onOpenFiles?.()}>
              打开脚本
            </Button>
          )}
        </div>
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
        ) : manualOnly && cases.filter((c) => c.is_manual).length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="没有标为「人工」的用例：目视样式类用例可在行内勾选「人工」"
            style={{ marginTop: 40 }}
          />
        ) : (
          (manualOnly ? cases.filter((c) => c.is_manual) : cases).map((c, i) => {
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
                    <Tag color={STATUS_TAG[c.status]?.color} className="case-flag">
                      {STATUS_TAG[c.status]?.label || c.status}
                    </Tag>
                    {c.is_manual ? (
                      <Tag color="blue" className="case-flag">
                        <UserOutlined /> 人工
                      </Tag>
                    ) : coveredIds.has(c.id) ? (
                      <Tag color="cyan" className="case-flag">
                        已进脚本
                      </Tag>
                    ) : uncoveredIds.has(c.id) ? (
                      <Tag color="orange" className="case-flag">
                        未覆盖
                      </Tag>
                    ) : null}
                    {c.source === 'ai' && (
                      <Tag color="purple" className="case-flag">
                        AI
                      </Tag>
                    )}
                  </span>

                  <span className="case-ops" onClick={(ev) => ev.stopPropagation()}>
                    {c.is_manual && (
                      <>
                        <Tooltip title="人工核对：通过">
                          <Button
                            size="small"
                            type="text"
                            icon={<CheckCircleOutlined style={{ color: '#00b42a' }} />}
                            onClick={() => void markManual(c, 'passed')}
                          />
                        </Tooltip>
                        <Tooltip title="人工核对：失败">
                          <Button
                            size="small"
                            type="text"
                            icon={<CloseCircleOutlined style={{ color: '#f54a45' }} />}
                            onClick={() => void markManual(c, 'failed')}
                          />
                        </Tooltip>
                      </>
                    )}
                    <Tooltip title={c.is_manual ? '取消人工标记' : '标为人工核对项'}>
                      <Button
                        size="small"
                        type="text"
                        icon={<UserOutlined style={c.is_manual ? { color: '#3370ff' } : undefined} />}
                        onClick={() => void toggleManual(c, !c.is_manual)}
                      />
                    </Tooltip>
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
              <>
                <Checkbox
                  checked={!!draft.is_manual}
                  onChange={(e) => setDraft({ ...draft, is_manual: e.target.checked })}
                >
                  人工验收项（不进总验收脚本，由人在页面勾选；如目视样式类）
                </Checkbox>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  也可以先在右侧对话里让 Agent 生成用例，结束后会自动导入到这里。
                </Typography.Text>
              </>
            )}
          </Space>
        )}
      </Modal>

      {/* 执行验收脚本输出 */}
      <Modal
        title={runOut?.title}
        open={!!runOut}
        onCancel={() => setRunOut(null)}
        footer={<Button onClick={() => setRunOut(null)}>关闭</Button>}
        width={720}
        destroyOnHidden
      >
        <pre className="case-run-output">{runOut?.body}</pre>
      </Modal>
    </div>
  )
}
