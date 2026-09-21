import { useEffect, useRef, useState } from 'react'
import {
  App as AntdApp,
  Alert,
  Button,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileAddOutlined,
  HistoryOutlined,
  PaperClipOutlined,
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import {
  Attachment,
  Requirement,
  deleteAttachment,
  describeError,
  listAttachments,
  readFile,
  updateRequirement,
  uploadRequirementAttachments,
} from '../api'
import { extOf } from '../chatAttachments'
import RichText from './RichText'
import VersionHistoryDrawer from './VersionHistoryDrawer'
import FilePreview, { previewKindOf, hasPreviewMode } from './FileViewer'

const DOC_TEMPLATE = `## 背景

（为什么要做这件事）

## 目标

- 

## 功能点

1. 

## 验收要点

- 
`

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

/**
 * 需求澄清：两份文档 + 附件。
 * - 原始需求：业务人员手写、看历史版本；需求名称创建后不可修改
 *   （.janus/ 工作区目录名依据需求名称固定）；
 * - 详细设计：在右侧对话里点「生成详细设计」快捷指令，由 Agent 写到工作区规范路径，
 *   编辑器会实时查询工作区并自动载入最新内容，保存后落库记版本；编码 Agent 照它实现；
 * - 附件：支持多文件上传，落在项目工作区 .janus/{需求目录}/requirement/attach/ 下。
 * 保存时数据库是权威来源，后端会把正文镜像到 .janus/{需求目录}/requirement/，
 * 编码 Agent 按固定路径（origin.md / design.md）读取。
 */
export default function RequirementDocPane({
  token,
  pid,
  requirement,
  onSaved,
  refreshSignal = 0,
}: {
  token: string | null
  pid?: number | null
  requirement: Requirement | null
  onSaved: (r: Requirement) => void
  /** Agent 产生文件改动 / 一轮对话结束时自增，触发立即拉取工作区文档 */
  refreshSignal?: number
}) {
  const { message } = AntdApp.useApp()
  const [title, setTitle] = useState('')
  const [doc, setDoc] = useState('')
  const [design, setDesign] = useState('')
  const [saved, setSaved] = useState<{ title: string; doc: string; design: string }>({ title: '', doc: '', design: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<{ title: string; hint: string } | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [tab, setTab] = useState<'original' | 'design'>('original')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [atts, setAtts] = useState<Attachment[]>([])
  const [attsLoading, setAttsLoading] = useState(false)
  const [preview, setPreview] = useState<{ path: string; ext: string; content: string; name: string } | null>(null)

  useEffect(() => {
    const t = requirement?.title || ''
    const d = requirement?.description || ''
    const g = requirement?.design_doc || ''
    setTitle(t)
    setDoc(d)
    setDesign(g)
    setSaved({ title: t, doc: d, design: g })
    setErr(null)
  }, [requirement?.id, requirement?.title, requirement?.description, requirement?.design_doc])

  const loadAtts = async (silent = false) => {
    if (!requirement) return
    if (!silent) setAttsLoading(true)
    try {
      setAtts(await listAttachments(token, requirement.id))
    } catch (e) {
      if (!silent) {
        const info = describeError(e)
        message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
      }
    } finally {
      setAttsLoading(false)
    }
  }

  useEffect(() => {
    void loadAtts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirement?.id, token])

  const dirty = title !== saved.title || doc !== saved.doc || design !== saved.design
  const activeDoc = tab === 'original' ? doc : design
  const setActiveDoc = (v: string) => (tab === 'original' ? setDoc(v) : setDesign(v))
  const chars = activeDoc.trim().length

  const openAttPreview = async (a: Attachment) => {
    if (pid == null) {
      message.warning('无法预览：缺少项目上下文')
      return
    }
    const ext = extOf(a.filename)
    const kind = previewKindOf(ext)
    const binaryPreview =
      kind === 'pdf' || kind === 'image' || kind === 'sheet' || kind === 'docx' || kind === 'office-legacy'
    let content = ''
    if (!binaryPreview) {
      try {
        content = (await readFile(token, pid, a.path)).content
      } catch {
        /* 读不到内容时仍打开预览 */
      }
    }
    setPreview({ path: a.path, ext, content, name: a.filename })
  }

  const save = async () => {
    if (!requirement || saving) return
    if (!title.trim()) return message.warning('需求标题不能为空')
    setSaving(true)
    try {
      const body: Record<string, unknown> = { title: title.trim(), source: 'manual' }
      if (doc !== saved.doc) body.description = doc
      if (design !== saved.design) body.design_doc = design
      const r = await updateRequirement(token, requirement.id, body)
      onSaved(r)
      setSaved({ title: title.trim(), doc, design })
      message.success('文档已保存（正文会同步写入项目目录 .janus/ 需求目录下）')
    } catch (e) {
      const info = describeError(e)
      setErr({ title: info.title, hint: info.hint })
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setSaving(false)
    }
  }

  // 工作区文档实时同步：不再需要手动点「从工作区同步」。
  // 定时轮询 + Agent 改动信号触发，读取 .janus/ 下 origin.md / design.md：
  // - 编辑器没有未保存的人工修改 → 自动载入工作区最新内容（未保存标记会提示点保存记一版）；
  // - 有人工修改 → 不覆盖，标记「工作区有更新」由用户决定取舍（点标记载入）。
  const wsContentRef = useRef<{ original: string | null; design: string | null }>({
    original: null,
    design: null,
  })
  const [wsStale, setWsStale] = useState<{ original: boolean; design: boolean }>({
    original: false,
    design: false,
  })

  const pullWorkspace = async (silent = true) => {
    if (!requirement || !pid) return
    const dir = requirement.dir_name
    if (!dir) return
    const rels = {
      original: `.janus/${dir}/requirement/origin.md`,
      design: `.janus/${dir}/requirement/design.md`,
    }
    for (const key of ['original', 'design'] as const) {
      try {
        const f = await readFile(token, pid, rels[key])
        if (f.binary) continue
        const prevWs = wsContentRef.current[key]
        wsContentRef.current[key] = f.content
        const current = key === 'original' ? doc : design
        const baseline = key === 'original' ? saved.doc : saved.design
        if (f.content === current) {
          setWsStale((s) => (s[key] ? { ...s, [key]: false } : s))
          continue
        }
        if (current === baseline) {
          // 无人工修改：自动载入最新内容
          if (key === 'original') setDoc(f.content)
          else setDesign(f.content)
          setWsStale((s) => ({ ...s, [key]: false }))
          if (!silent && (prevWs === null || prevWs !== f.content)) {
            message.success('已自动载入工作区最新文档，点「保存」记一版')
          }
        } else {
          setWsStale((s) => ({ ...s, [key]: true }))
        }
      } catch (e) {
        const info = describeError(e)
        if (info.status === 404) {
          // 工作区还没有这份文档（例如 design.md 尚未生成），属正常
          wsContentRef.current[key] = null
        } else if (!silent) {
          message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
        }
      }
    }
  }

  // pullWorkspace 每次渲染重建（读最新 doc/design/saved），定时器通过 ref 取最新版本
  const pullRef = useRef(pullWorkspace)
  useEffect(() => {
    pullRef.current = pullWorkspace
  })

  // 定时轮询工作区文档（实时同步的主体）
  useEffect(() => {
    if (!requirement || !pid) return
    const t = setInterval(() => void pullRef.current(), 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirement?.id, requirement?.dir_name, pid, token])

  // Agent 改动了文件 / 一轮对话结束：立即拉取
  useEffect(() => {
    if (refreshSignal > 0) void pullRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  const uploadAtts = async (files: File[]) => {
    if (!requirement || !files.length) return
    try {
      const rows = await uploadRequirementAttachments(token, requirement.id, files)
      message.success(`已上传 ${rows.length} 个附件`)
      await loadAtts(true)
    } catch (e) {
      const info = describeError(e)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
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

  const revert = () => {
    setTitle(saved.title)
    setDoc(saved.doc)
    setDesign(saved.design)
  }

  const originalToolbar = (
    <Tooltip title="查看历次保存的文档、与当前对比，并回退到任意一版">
      <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
        历史版本
      </Button>
    </Tooltip>
  )

  /** 工作区有更新且本地有未保存的人工修改时，点此放弃本地修改、载入工作区版本。 */
  const loadWsVersion = () => {
    const ws = wsContentRef.current[tab]
    if (!ws) return
    if (tab === 'original') setDoc(ws)
    else setDesign(ws)
    setWsStale((s) => ({ ...s, [tab]: false }))
    message.success('已载入工作区最新版本，点「保存」记一版')
  }

  const wsStaleTag = wsStale[tab] ? (
    <Tooltip title="Agent 改写了工作区文档，而编辑器里有未保存的人工修改；点击放弃本地修改、载入工作区最新版">
      <Tag
        color="gold"
        style={{ marginInlineEnd: 0, cursor: 'pointer' }}
        onClick={loadWsVersion}
      >
        工作区有更新
      </Tag>
    </Tooltip>
  ) : null

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const attUploader = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        const files = Array.from(e.target.files || [])
        e.target.value = ''
        void uploadAtts(files)
      }}
    />
  )

  return (
    <div className="doc-pane" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }}>
      <div className="doc-head">
        <Input
          className="doc-title"
          value={title}
          placeholder="需求标题（一句话说清要做什么）"
          readOnly
          title="需求名称创建后不可修改（.janus/ 工作区目录名依据需求名称固定）"
          variant="borderless"
          maxLength={200}
        />
        <Space size={6} wrap>
          <Tag color={chars ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
            {chars} 字
          </Tag>
          {dirty ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>未保存</Tag> : null}
        </Space>
      </div>

      <div className="doc-toolbar">
        <Space size={4} wrap>
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!dirty}
            onClick={save}
          >
            保存
          </Button>
          {tab === 'original' ? originalToolbar : null}
          {wsStaleTag}
          <Button
            size="small"
            type="text"
            disabled={!activeDoc}
            onClick={() => setActiveDoc(DOC_TEMPLATE)}
            title="插入需求文档模板"
          >
            插入模板
          </Button>
          {dirty && (
            <Button size="small" type="text" icon={<UndoOutlined />} onClick={revert}>
              还原
            </Button>
          )}
        </Space>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as 'edit' | 'preview')}
          options={[
            { value: 'edit', icon: <EditOutlined />, label: '编辑' },
            { value: 'preview', icon: <EyeOutlined />, label: '预览' },
          ]}
        />
      </div>

      {err && (
        <Alert
          type="error"
          showIcon
          style={{ margin: '0 10px 8px' }}
          message={err.title}
          description={err.hint ? <span style={{ fontSize: 12 }}>{err.hint}</span> : undefined}
        />
      )}

      <Tabs
        size="small"
        className="doc-tabs"
        activeKey={tab}
        onChange={(k) => setTab(k as 'original' | 'design')}
        items={[
          { key: 'original', label: '原始需求' },
          { key: 'design', label: '详细设计' },
        ]}
      />

      <div className="doc-body">
        {mode === 'preview' ? (
          <div className="doc-preview">
            {activeDoc.trim() ? (
              <RichText text={activeDoc} />
            ) : (
              <Typography.Text type="secondary">
                （文档为空，切到「编辑」开始书写{tab === 'design' ? '，或在右侧对话里点「生成详细设计」' : ''}）
              </Typography.Text>
            )}
          </div>
        ) : (
          <Input.TextArea
            className="doc-editor"
            value={activeDoc}
            spellCheck={false}
            placeholder={
              tab === 'original'
                ? '用 Markdown 写清楚：背景 / 目标 / 功能点 / 验收要点。\n写不动也没关系，在右侧对话里点「润色需求文档」。'
                : '详细设计文档：在右侧对话里点「生成详细设计」，写完会自动载入到这里。\n编码 Agent 在「编码实现」阶段会按这份文档干活。'
            }
            onChange={(e) => setActiveDoc(e.target.value)}
            autoSize={false}
          />
        )}
      </div>

      {/* 需求附件：落在项目工作区 .janus/{需求目录}/requirement/attach/，Agent 可按路径引用 */}
      <div className="doc-atts">
        <div className="doc-atts-head">
          <Space size={6}>
            <PaperClipOutlined />
            <Typography.Text strong style={{ fontSize: 13 }}>附件</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {atts.length ? `${atts.length} 个` : ''}存入 .janus/{requirement?.dir_name || '需求目录'}/requirement/attach/
            </Typography.Text>
          </Space>
          <Button
            size="small"
            icon={<FileAddOutlined />}
            disabled={!requirement}
            onClick={() => fileInputRef.current?.click()}
          >
            上传附件
          </Button>
          {attUploader}
        </div>
        {attsLoading && atts.length === 0 ? (
          <Spin size="small" style={{ margin: '8px 12px' }} />
        ) : atts.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, padding: '0 12px 8px', display: 'block' }}>
            支持多文件（原型图、接口文档、截图…），生成详细设计时会自动参考
          </Typography.Text>
        ) : (
          <div className="doc-att-list">
            {atts.map((a) => (
              <div
                className="doc-att doc-att-clickable"
                key={a.id}
                title={pid == null ? a.path : `点击预览 · ${a.path}`}
                onClick={() => void openAttPreview(a)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void openAttPreview(a)
                  }
                }}
              >
                <PaperClipOutlined className="doc-att-icon" />
                <span className="doc-att-name">{a.filename}</span>
                <Tag style={{ marginInlineEnd: 0 }} color="default">{fmtSize(a.size)}</Tag>
                <Popconfirm
                  title={`删除附件「${a.filename}」？`}
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void removeAtt(a)}
                >
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        title={preview?.name}
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={<a onClick={() => setPreview(null)}>关闭</a>}
        width="100vw"
        style={{ top: 0, maxWidth: '100vw', paddingBottom: 0 }}
        wrapClassName="fv-modal-fullscreen"
        destroyOnHidden
      >
        {preview && pid != null && (
          <div className="fv-stage fv-stage-full">
            {hasPreviewMode(preview.ext) ? (
              <FilePreview
                pid={pid}
                token={token ?? null}
                path={preview.path}
                ext={preview.ext}
                content={preview.content}
                fullscreen
              />
            ) : (
              <pre className="code-block" style={{ maxHeight: 'calc(100vh - 200px)' }}>
                {preview.content || '（空文件或内容不可预览）'}
              </pre>
            )}
          </div>
        )}
      </Modal>

      <VersionHistoryDrawer
        token={token}
        requirement={requirement}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestored={onSaved}
      />
    </div>
  )
}
