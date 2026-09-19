import { useCallback, useEffect, useRef, useState } from 'react'
import type { Key } from 'react'
import {
  App as AntdApp,
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Skeleton,
  Switch,
  Tag,
  Tooltip,
  Tree,
  Typography,
} from 'antd'
import type { MenuProps, TreeDataNode } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MoreOutlined,
  ReloadOutlined,
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import {
  ApiError,
  FileEntry,
  describeError,
  createEntry,
  deleteEntry,
  listFiles,
  readFile,
  renameEntry,
  saveFile,
} from '../api'
import FilePreview, { hasPreviewMode, previewKindOf } from './FileViewer'
import RichText from './RichText'

/** 空字符串代表项目根目录（后端约定：path 为空即根）。 */
const ROOT = ''

/** 重目录不进树默认视图，避免一展开就被 node_modules 淹没。 */
const IGNORE = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  '.idea',
  '.vscode',
  '.DS_Store',
])

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const TEXT_EXT = new Set(['txt', 'log', 'ini', 'conf', 'env', 'yaml', 'yml', 'toml', 'cfg'])

const parentOf = (p: string) => p.split('/').slice(0, -1).join('')
const under = (p: string, candidate: string) => candidate === p || candidate.startsWith(p + '/')

function fileIcon(e: FileEntry) {
  if (e.type === 'dir') return <FolderOutlined style={{ color: '#ffb020' }} />
  if (e.ext === 'md' || e.ext === 'markdown') return <FileMarkdownOutlined style={{ color: '#3370ff' }} />
  if (e.ext === 'pdf') return <FilePdfOutlined style={{ color: '#f54a45' }} />
  if (['xlsx', 'xls', 'csv'].includes(e.ext)) return <FileExcelOutlined style={{ color: '#0d7a2a' }} />
  if (['doc', 'docx', 'wps'].includes(e.ext)) return <FileWordOutlined style={{ color: '#3370ff' }} />
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(e.ext))
    return <FileImageOutlined style={{ color: '#8a5cf6' }} />
  if (TEXT_EXT.has(e.ext)) return <FileTextOutlined style={{ color: '#8f959e' }} />
  return <FileOutlined style={{ color: '#8f959e' }} />
}

function fmtSize(n: number | null) {
  if (n === null || n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

interface EditorState {
  path: string
  content: string
  original: string
  binary: boolean
  truncated: boolean
  message: string
  size: number
  /** 小写扩展名，决定弹窗里的预览形态。 */
  ext: string
  /** preview=预览 / 语法渲染；edit=源码（可编辑）。 */
  view: 'preview' | 'edit'
}

interface NamingState {
  mode: 'file' | 'dir' | 'rename'
  /** 新建时的父目录（'' 表示根目录）。 */
  base: string
  /** 重命名时的目标节点。 */
  target?: FileEntry
}

/** 文件面板：项目工作区树形浏览 + 新建 / 编辑保存 / 重命名 / 删除。
 *  目录懒加载（展开时才拉取），避免大工程一次性铺开。 */
export default function FilePane({
  pid,
  token,
  diskPath,
  refreshSignal = 0,
}: {
  pid: number | null
  token: string | null
  diskPath?: string | null
  /** 外部（如 Agent 产出改动）递增该值即可让已加载的目录重新拉取。 */
  refreshSignal?: number
}) {
  const { message, modal } = AntdApp.useApp()
  const [childrenOf, setChildrenOf] = useState<Record<string, FileEntry[]>>({})
  const [loadedKeys, setLoadedKeys] = useState<string[]>([])
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)
  const [busyDirs, setBusyDirs] = useState<string[]>([])
  const [err, setErr] = useState<{ title: string; hint: string } | null>(null)
  const [hideIgnored, setHideIgnored] = useState(true)
  const [editor, setEditor] = useState<EditorState | null>(null)
  /** 预览弹窗是否全屏（仅影响展示，不改变编辑状态）。 */
  const [fullscreen, setFullscreen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [naming, setNaming] = useState<NamingState | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [nameErr, setNameErr] = useState<string | null>(null)
  const [nameBusy, setNameBusy] = useState(false)
  const inflight = useRef<Set<string>>(new Set())
  const bootSeq = useRef(0)

  /** 拉取某个目录的直接子项；同一目录并发请求自动去重。 */
  const loadDir = useCallback(
    async (path: string, opts?: { silent?: boolean }) => {
      if (pid === null) return null
      if (inflight.current.has(path)) return null
      inflight.current.add(path)
      setBusyDirs((b) => (b.includes(path) ? b : [...b, path]))
      try {
        const res = await listFiles(token, pid, path)
        setChildrenOf((prev) => ({ ...prev, [res.path]: res.entries }))
        setLoadedKeys((k) => (k.includes(res.path) ? k : [...k, res.path]))
        setErr(null)
        return res
      } catch (e) {
        const info = describeError(e)
        if (!opts?.silent) setErr({ title: info.title, hint: info.hint })
        return null
      } finally {
        inflight.current.delete(path)
        setBusyDirs((b) => b.filter((x) => x !== path))
      }
    },
    [pid, token],
  )

  // 项目/令牌变化：整棵树重来
  useEffect(() => {
    const seq = ++bootSeq.current
    inflight.current.clear()
    setChildrenOf({})
    setLoadedKeys([])
    setExpandedKeys([])
    setSelected(null)
    setErr(null)
    setEditor(null)
    if (pid === null) {
      setBooting(false)
      return
    }
    setBooting(true)
    loadDir(ROOT).finally(() => {
      if (seq === bootSeq.current) setBooting(false)
    })
  }, [loadDir, pid])

  /** 重新拉取所有已加载目录（保留展开状态，不闪树）。 */
  const refreshAll = useCallback(
    async (silent = false) => {
      const keys = loadedKeys.length ? loadedKeys : [ROOT]
      await Promise.all(keys.map((k) => loadDir(k, { silent })))
    },
    [loadedKeys, loadDir],
  )

  // 弹窗关闭即退出全屏
  useEffect(() => {
    if (!editor) setFullscreen(false)
  }, [editor])

  // 全屏时 Esc 先退全屏（捕获阶段拦下，避免 antd Modal 直接关弹窗）
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [fullscreen])

  // Agent 产生新改动时自动刷新（静默重取，不打断）
  useEffect(() => {
    if (refreshSignal > 0) void refreshAll(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  /** 展开目录（未加载过则顺手拉一次，不依赖组件的懒加载时机）。 */
  const expandDir = useCallback(
    (path: string) => {
      setExpandedKeys((prev) => (prev.includes(path) ? prev : [...prev, path]))
      if (!Object.prototype.hasOwnProperty.call(childrenOf, path)) void loadDir(path)
    },
    [childrenOf, loadDir],
  )

  /** 改名 / 删除后，把该节点及其子树从缓存与展开态里摘掉。 */
  const forgetSubtree = useCallback((path: string) => {
    setChildrenOf((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([k]) => !under(path, k))),
    )
    setLoadedKeys((prev) => prev.filter((k) => !under(path, k)))
    setExpandedKeys((prev) => prev.filter((k) => !under(path, k)))
  }, [])

  const openFile = useCallback(
    async (e: FileEntry) => {
      if (pid === null) return
      try {
        const f = await readFile(token, pid, e.path)
        const ext = (e.ext || e.path.split('.').pop() || '').toLowerCase()
        const kind = previewKindOf(ext)
        // pdf / 图片 / 表格 / docx 等二进制预览型：只能预览（字节流由预览器自行拉取）；
        // 其余有预览形态的默认进预览；纯文本/未知类型直接进源码编辑（原行为）
        const previewOnly =
          kind === 'pdf' || kind === 'image' || kind === 'sheet' || kind === 'docx' || kind === 'office-legacy'
        const view: EditorState['view'] =
          !previewOnly && (f.binary || f.truncated || !hasPreviewMode(ext)) ? 'edit' : 'preview'
        setEditor({
          path: f.path,
          content: f.content,
          original: f.content,
          binary: f.binary,
          truncated: f.truncated,
          message: f.message,
          size: f.size,
          ext,
          view,
        })
      } catch (ex) {
        const info = describeError(ex)
        message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
      }
    },
    [message, pid, token],
  )

  const doSave = async () => {
    if (!editor || pid === null || saving) return
    setSaving(true)
    try {
      const r = await saveFile(token, pid, editor.path, editor.content)
      setEditor({ ...editor, original: editor.content, size: r.size })
      message.success(r.created ? `已新建 ${r.path}` : `已保存 ${r.path}`)
      // 文件可能落在尚未加载的目录里：连父目录一起刷新，保证树上能看到
      await loadDir(parentOf(r.path), { silent: true })
    } catch (ex) {
      const info = describeError(ex)
      message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
    } finally {
      setSaving(false)
    }
  }

  const closeEditor = () => {
    if (!editor) return
    if (editor.content !== editor.original) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content: editor.path,
        okText: '放弃修改',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: () => setEditor(null),
      })
      return
    }
    setEditor(null)
  }

  const startCreate = (mode: 'file' | 'dir', base: string) => {
    setNaming({ mode, base })
    setNameInput('')
    setNameErr(null)
  }

  const startRename = (e: FileEntry) => {
    setNaming({ mode: 'rename', base: parentOf(e.path), target: e })
    setNameInput(e.name)
    setNameErr(null)
  }

  const submitName = async () => {
    if (pid === null || !naming) return
    const name = nameInput.trim()
    if (!name) return setNameErr('名称不能为空')
    if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
      return setNameErr('名称不能包含 /、\\ 或 ..')
    }
    setNameBusy(true)
    try {
      if (naming.mode === 'rename' && naming.target) {
        const old = naming.target
        const parent = parentOf(old.path)
        const r = await renameEntry(token, pid, old.path, name)
        const newPath = parent ? `${parent}/${name}` : name
        forgetSubtree(old.path)
        setSelected(newPath)
        await loadDir(parent)
        message.success(`已重命名为 ${r.name}`)
      } else {
        const base = naming.base
        const full = base ? `${base}/${name}` : name
        await createEntry(token, pid, full, naming.mode === 'dir' ? 'dir' : 'file')
        if (base) setExpandedKeys((prev) => (prev.includes(base) ? prev : [...prev, base]))
        setSelected(full)
        await loadDir(base)
        message.success(naming.mode === 'dir' ? `已新建目录 ${name}` : `已新建文件 ${name}`)
      }
      setNaming(null)
      setNameInput('')
      setNameErr(null)
    } catch (ex) {
      setNameErr(ex instanceof ApiError ? ex.detail || ex.message : String(ex))
    } finally {
      setNameBusy(false)
    }
  }

  const confirmDelete = (e: FileEntry) => {
    if (pid === null) return
    const finish = async (recursive: boolean) => {
      await deleteEntry(token, pid, e.path, recursive)
      forgetSubtree(e.path)
      setSelected((cur) => (cur && under(e.path, cur) ? null : cur))
      await loadDir(parentOf(e.path))
      message.success(`已删除 ${e.name}`)
    }
    modal.confirm({
      title: `删除${e.type === 'dir' ? '目录' : '文件'}「${e.name}」？`,
      content:
        e.type === 'dir'
          ? '目录会连同内部所有内容一起删除，此操作不可撤销。'
          : '删除后不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await finish(false)
          return
        } catch (ex) {
          const info = describeError(ex)
          if (e.type === 'dir' && info.status === 400) {
            // 非空目录：再确认一次才递归删除
            modal.confirm({
              title: '目录非空，递归删除内部全部内容？',
              content: e.path,
              okText: '全部删除',
              okButtonProps: { danger: true },
              cancelText: '取消',
              onOk: async () => {
                try {
                  await finish(true)
                } catch (ex2) {
                  const i2 = describeError(ex2)
                  message.error(`${i2.title}${i2.detail ? '：' + i2.detail : ''}`)
                }
              },
            })
            return
          }
          message.error(`${info.title}${info.detail ? '：' + info.detail : ''}`)
        }
      },
    })
  }

  // ---------------- 树构建 ----------------

  const index: Record<string, FileEntry> = {}
  const hiddenCount = hideIgnored
    ? Object.values(childrenOf).reduce((n, list) => n + list.filter((e) => IGNORE.has(e.name)).length, 0)
    : 0

  function renderTitle(e: FileEntry) {
    const isDir = e.type === 'dir'
    const items: MenuProps['items'] = [
      ...(isDir
        ? [
            { key: 'new-file', icon: <FileAddOutlined />, label: '在此新建文件' },
            { key: 'new-dir', icon: <FolderAddOutlined />, label: '在此新建文件夹' },
            { type: 'divider' as const },
          ]
        : []),
      { key: 'rename', icon: <EditOutlined />, label: '重命名' },
      { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
    ]
    return (
      <div className="fp-node" title={e.path}>
        <span className="fp-icon">{fileIcon(e)}</span>
        <span className="fp-name">{e.name}</span>
        {!isDir && <span className="fp-meta">{fmtSize(e.size)}</span>}
        <Dropdown
          trigger={['click']}
          menu={{
            items,
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation()
              if (key === 'new-file') startCreate('file', e.path)
              else if (key === 'new-dir') startCreate('dir', e.path)
              else if (key === 'rename') startRename(e)
              else if (key === 'delete') confirmDelete(e)
            },
          }}
        >
          <span className="fp-ops" onClick={(ev) => ev.stopPropagation()}>
            <Button size="small" type="text" icon={<MoreOutlined />} />
          </span>
        </Dropdown>
      </div>
    )
  }

  const buildNodes = (path: string): TreeDataNode[] => {
    const list = childrenOf[path] || []
    const items = hideIgnored ? list.filter((e) => !IGNORE.has(e.name)) : list
    return items.map((e) => {
      index[e.path] = e
      const kids = childrenOf[e.path]
      const emptyDir = e.type === 'dir' && kids !== undefined && kids.length === 0
      return {
        key: e.path,
        isLeaf: e.type === 'file' || emptyDir,
        title: renderTitle(e),
        children: e.type === 'dir' && kids && kids.length > 0 ? buildNodes(e.path) : undefined,
      }
    })
  }

  const treeData = pid === null ? [] : buildNodes(ROOT)

  const sel = selected ? index[selected] : undefined
  const targetDir = sel ? (sel.type === 'dir' ? sel.path : parentOf(sel.path)) : ROOT
  const dirty = !!editor && editor.content !== editor.original

  // 弹窗内的预览形态控制：仅 html / md / 代码 提供预览 ↔ 源码切换
  const editorKind = editor ? previewKindOf(editor.ext) : null
  const previewOnly =
    !!editorKind &&
    (editorKind === 'pdf' || editorKind === 'image' || editorKind === 'sheet' ||
      editorKind === 'docx' || editorKind === 'office-legacy')
  const showViewSwitch =
    !!editor && !previewOnly && (editorKind === 'html' || editorKind === 'md' || editorKind === 'code')

  const onSelect = (_keys: Key[], info: { node: { key: Key } }) => {
    const key = String(info.node.key)
    const e = index[key]
    if (!e) return
    setSelected(key)
    if (e.type === 'dir') {
      // 目录：单击即展开 / 收起（树里不再需要单独的进入动作）
      if (expandedKeys.includes(key)) setExpandedKeys((prev) => prev.filter((k) => k !== key))
      else expandDir(key)
    } else {
      void openFile(e)
    }
  }

  if (pid === null) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="会话未关联项目，无法浏览文件"
        style={{ marginTop: 48 }}
      />
    )
  }

  const loading = busyDirs.length > 0

  return (
    <div className="fp-root">
      <div className="fp-actions">
        <Space size={2} wrap>
          <Tooltip title={loading ? '正在加载…' : '刷新已展开的目录'}>
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined spin={loading} />}
              disabled={loading}
              onClick={() => void refreshAll()}
            />
          </Tooltip>
          <Tooltip title="在当前位置新建文件">
            <Button size="small" type="text" icon={<FileAddOutlined />} onClick={() => startCreate('file', targetDir)}>
              新建文件
            </Button>
          </Tooltip>
          <Tooltip title="在当前位置新建文件夹">
            <Button size="small" type="text" icon={<FolderAddOutlined />} onClick={() => startCreate('dir', targetDir)}>
              新建文件夹
            </Button>
          </Tooltip>
        </Space>
        {hiddenCount > 0 && (
          <Tooltip title={`已隐藏 ${hiddenCount} 个依赖 / 缓存目录`}>
            <Space size={6} style={{ fontSize: 12, color: '#8f959e' }}>
              <Switch size="small" checked={hideIgnored} onChange={setHideIgnored} />
              过滤
            </Space>
          </Tooltip>
        )}
      </div>

      <div className="fp-path">
        <FolderOpenOutlined style={{ color: '#ffb020' }} />
        <span className="fp-path-label">新建位置</span>
        <Typography.Text
          className="fp-path-val"
          style={{ fontSize: 11.5, fontFamily: MONO }}
          ellipsis={{ tooltip: targetDir || '项目根目录' }}
        >
          {targetDir || '项目根目录'}
        </Typography.Text>
      </div>

      {err && (
        <Alert
          type="error"
          showIcon
          style={{ margin: '8px 12px 0' }}
          message={err.title}
          description={
            <Space direction="vertical" size={6}>
              {err.hint && <span style={{ fontSize: 12 }}>{err.hint}</span>}
              <Button size="small" onClick={() => void loadDir(ROOT)}>
                重试
              </Button>
            </Space>
          }
        />
      )}

      <div className="fp-tree">
        {booting && treeData.length === 0 ? (
          <div style={{ padding: '8px 10px' }}>
            <Skeleton active title={false} paragraph={{ rows: 3 }} />
            <Skeleton active title={false} paragraph={{ rows: 2 }} />
          </div>
        ) : treeData.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={hiddenCount > 0 ? '本层都是被过滤的依赖目录' : '空目录'}
            style={{ marginTop: 40 }}
          />
        ) : (
          <Tree
            blockNode
            showLine={{ showLeafIcon: false }}
            treeData={treeData}
            loadData={(node) => {
              const key = String(node.key)
              if (Object.prototype.hasOwnProperty.call(childrenOf, key)) return Promise.resolve()
              return loadDir(key).then(() => undefined)
            }}
            loadedKeys={loadedKeys}
            expandedKeys={expandedKeys}
            selectedKeys={selected ? [selected] : []}
            onExpand={(keys) => setExpandedKeys(keys.map(String))}
            onSelect={onSelect}
          />
        )}
      </div>

      {diskPath && (
        <div className="fp-foot">
          <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: diskPath }}>
            {diskPath}
          </Typography.Text>
        </div>
      )}

      {/* 新建 / 重命名 */}
      <Modal
        title={naming?.mode === 'rename' ? '重命名' : naming?.mode === 'dir' ? '新建文件夹' : '新建文件'}
        open={!!naming}
        onCancel={() => {
          setNaming(null)
          setNameErr(null)
        }}
        onOk={submitName}
        confirmLoading={nameBusy}
        okText={naming?.mode === 'rename' ? '重命名' : '创建'}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          位置：{naming?.mode === 'rename' ? naming.base : naming?.base ? naming.base + '/' : '项目根目录/'}
        </Typography.Paragraph>
        <Input
          autoFocus
          value={nameInput}
          status={nameErr ? 'error' : undefined}
          placeholder={naming?.mode === 'dir' ? '例如 components' : '例如 index.ts'}
          onChange={(e) => {
            setNameInput(e.target.value)
            if (nameErr) setNameErr(null)
          }}
          onPressEnter={submitName}
        />
        {nameErr && <div style={{ color: '#f54a45', fontSize: 12, marginTop: 6 }}>{nameErr}</div>}
      </Modal>

      {/* 文件编辑器 / 预览器 */}
      <Modal
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 24 }}>
            <Space size={8} wrap style={{ flex: 1, minWidth: 0 }}>
              <FileTextOutlined style={{ color: '#3370ff' }} />
              <span style={{ fontFamily: MONO, fontSize: 13 }}>{editor?.path}</span>
              {dirty && <Tag color="orange">未保存</Tag>}
              {editor?.binary && !previewOnly && <Tag>二进制</Tag>}
              {editor?.truncated && <Tag>已截断</Tag>}
            </Space>
            <Tooltip title={fullscreen ? '退出全屏' : '全屏预览'}>
              <Button
                size="small"
                type="text"
                icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={() => setFullscreen((f) => !f)}
              />
            </Tooltip>
          </div>
        }
        open={!!editor}
        width={fullscreen ? '100vw' : 920}
        style={fullscreen ? { top: 0, maxWidth: '100vw', paddingBottom: 0 } : undefined}
        wrapClassName={fullscreen ? 'fv-modal-fullscreen' : undefined}
        keyboard={!fullscreen}
        onCancel={closeEditor}
        destroyOnHidden
        footer={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 12, color: '#8f959e' }}>
              {fmtSize(editor?.size ?? null)}
              {editor?.view === 'edit' && !editor?.binary && !editor?.truncated
                ? ' · Ctrl / ⌘ + S 保存'
                : ''}
            </span>
            <Space size={8}>
              <Button
                icon={<UndoOutlined />}
                disabled={!dirty || editor?.view === 'preview'}
                onClick={() => editor && setEditor({ ...editor, content: editor.original })}
              >
                还原
              </Button>
              <Button onClick={closeEditor}>关闭</Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!dirty || editor?.view === 'preview'}
                onClick={doSave}
              >
                保存
              </Button>
            </Space>
          </div>
        }
      >
        <div className={fullscreen ? 'fv-stage fv-stage-full' : 'fv-stage'}>
          {showViewSwitch && (
            <div style={{ marginBottom: 10 }}>
              <Segmented
                size="small"
                value={editor?.view}
                onChange={(v) => editor && setEditor({ ...editor, view: v as EditorState['view'] })}
                options={
                  editorKind === 'code'
                    ? [
                        { label: '语法高亮', value: 'preview' },
                        { label: '源码', value: 'edit' },
                      ]
                    : [
                        { label: '预览', value: 'preview' },
                        { label: '源码', value: 'edit' },
                      ]
                }
              />
            </div>
          )}
          {editor && editor.message && !previewOnly && (
            <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={editor.message} />
          )}
          {editor && editor.view === 'preview' ? (
            <FilePreview
              pid={pid}
              token={token}
              path={editor.path}
              ext={editor.ext}
              content={editor.content}
              fullscreen={fullscreen}
            />
          ) : editor && !editor.binary && !editor.truncated ? (
            <Input.TextArea
              value={editor.content}
              spellCheck={false}
              onChange={(e) => editor && setEditor({ ...editor, content: e.target.value })}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault()
                  doSave()
                }
              }}
              style={{
                height: fullscreen ? 'calc(100vh - 230px)' : '58vh',
                fontFamily: MONO,
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            />
          ) : editor ? (
            <div style={{ maxHeight: '58vh', overflow: 'auto' }}>
              <RichText text={`无法编辑该文件：${editor.message || '内容不可用'}`} />
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
