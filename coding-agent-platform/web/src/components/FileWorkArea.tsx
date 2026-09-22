import { useState } from 'react'
import {
  ExperimentOutlined,
  FolderOutlined,
  HistoryOutlined,
  InboxOutlined,
  FileTextOutlined,
  CodeOutlined,
  QuestionCircleOutlined,
  FileSearchOutlined,
} from '@ant-design/icons'
import { Badge } from 'antd'
import type { Requirement, Stage, TestCase, WorkflowState } from '../api'
import RequirementDocPane from './RequirementDocPane'
import CasePane from './CasePane'
import ArchivePane from './ArchivePane'
import FilePane from './FilePane'
import ChangePane from './ChangePane'
import ScriptPane from './ScriptPane'
import HelpPanel from './HelpPanel'
import LogPane from './LogPane'

/**
 * 左栏固定文件区：竖向分类页签（需求 / Files / 脚本 / 日志 / 用例 / 归档 / 帮助）+
 * 分类内的横向子页签。不再随阶段整体切换 —— 阶段只决定默认落在哪个分类。
 * 需求目录按 .janus/{dir}/ 存储规范映射：requirement/、script/、usecase/、arch/。
 * 分类由父组件受控（Workbench owns cat），以支持快捷键切换（Alt+1~7）。
 */
export type Cat = 'req' | 'code' | 'script' | 'logs' | 'cases' | 'arch' | 'help'

/** 副屏可选 tab（不含帮助）。 */
export type AuxTab = Exclude<Cat, 'help'>

export const AUX_TAB_OPTIONS: { value: AuxTab; label: string }[] = [
  { value: 'req', label: '需求' },
  { value: 'code', label: 'Files' },
  { value: 'script', label: '脚本' },
  { value: 'logs', label: '日志' },
  { value: 'cases', label: '用例' },
  { value: 'arch', label: '归档' },
]

export const STAGE_CAT: Record<Stage, Cat> = {
  clarify: 'req',
  verify: 'cases',
  build: 'code',
  archive: 'arch',
}

/** 按分类渲染业务 pane（主屏与副屏共用）。 */
export function CatPaneContent({
  cat,
  token,
  pid,
  rid,
  requirement,
  flow,
  cases,
  casesLoading,
  diskPath,
  sessionId,
  refreshSignal,
  busy,
  onDocSaved,
  onReloadCases,
  onReverted,
  onAskAgent,
  onUseCommand,
  onCatChange,
  isAdmin,
  onOpenProjectSettings,
}: {
  cat: Cat | AuxTab
  token: string | null
  pid: number | null
  rid: number | null
  requirement: Requirement | null
  flow: WorkflowState | null
  cases: TestCase[]
  casesLoading: boolean
  diskPath?: string
  sessionId: number
  refreshSignal: number
  busy?: boolean
  onDocSaved: (r: Requirement) => void
  onReloadCases: (silent?: boolean) => Promise<void>
  onReverted: () => void
  onAskAgent?: () => void
  onUseCommand: (text: string) => void
  onCatChange?: (c: Cat) => void
  isAdmin?: boolean
  onOpenProjectSettings?: () => void
}) {
  const [codeTab, setCodeTab] = useState<'files' | 'changes'>('files')

  if (cat === 'req') {
    return <RequirementDocPane token={token} pid={pid} requirement={requirement} onSaved={onDocSaved} />
  }
  if (cat === 'code') {
    return (
      <div className="wb-tabs">
        <div className="wb-tabbar">
          {(
            [
              { key: 'files', label: '文件', icon: <FolderOutlined />, badge: 0 },
              { key: 'changes', label: '改动', icon: <HistoryOutlined />, badge: flow?.change_sets.files ?? 0 },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              className={`wb-tab${codeTab === t.key ? ' is-active' : ''}`}
              onClick={() => setCodeTab(t.key)}
            >
              <span className="wb-tab-icon">{t.icon}</span>
              {t.label}
              {t.badge > 0 && <Badge count={t.badge} color="#3370ff" style={{ marginLeft: 2 }} />}
            </button>
          ))}
        </div>
        <div className="wb-tabbody">
          {codeTab === 'files' && (
            <FilePane pid={pid} token={token} diskPath={diskPath} refreshSignal={refreshSignal} />
          )}
          {codeTab === 'changes' && (
            <ChangePane
              token={token}
              pid={pid}
              sessionId={sessionId}
              refreshSignal={refreshSignal}
              onReverted={onReverted}
            />
          )}
        </div>
      </div>
    )
  }
  if (cat === 'script') {
    return (
      <ScriptPane
        token={token}
        rid={rid}
        dir={requirement?.dir_name || ''}
        busy={busy}
        refreshSignal={refreshSignal}
        onUseCommand={onUseCommand}
      />
    )
  }
  if (cat === 'logs') {
    return (
      <LogPane token={token} pid={pid} isAdmin={isAdmin} onOpenSettings={onOpenProjectSettings} />
    )
  }
  if (cat === 'cases') {
    return (
      <CasePane
        token={token}
        pid={pid}
        rid={rid}
        dir={requirement?.dir_name || ''}
        cases={cases}
        loading={casesLoading}
        onReload={onReloadCases}
        onAskAgent={onAskAgent}
        onUseCommand={onUseCommand}
        onOpenFiles={() => onCatChange?.('code')}
        refreshSignal={refreshSignal}
      />
    )
  }
  if (cat === 'arch') {
    return (
      <ArchivePane
        token={token}
        rid={rid}
        flow={flow}
        cases={cases}
        onReload={(silent) => onReloadCases(silent)}
      />
    )
  }
  if (cat === 'help') {
    return <HelpPanel dir={requirement?.dir_name || ''} busy={busy} onUse={onUseCommand} />
  }
  return null
}

export default function FileWorkArea({
  token,
  pid,
  rid,
  cat,
  onCatChange,
  requirement,
  flow,
  cases,
  casesLoading,
  diskPath,
  sessionId,
  refreshSignal,
  busy,
  onDocSaved,
  onReloadCases,
  onReverted,
  onAskAgent,
  onUseCommand,
  isAdmin,
  onOpenProjectSettings,
}: {
  token: string | null
  pid: number | null
  rid: number | null
  /** 当前左栏分类（受控）。 */
  cat: Cat
  onCatChange: (c: Cat) => void
  requirement: Requirement | null
  flow: WorkflowState | null
  cases: TestCase[]
  casesLoading: boolean
  diskPath?: string
  sessionId: number
  refreshSignal: number
  busy?: boolean
  onDocSaved: (r: Requirement) => void
  onReloadCases: (silent?: boolean) => Promise<void>
  onReverted: () => void
  /** 用例配置的「让 Agent 生成用例」入口：把草稿话术灌入右侧输入框。 */
  onAskAgent?: () => void
  /** 帮助面板「常用指令」点选：把话术填入右侧对话输入框。 */
  onUseCommand: (text: string) => void
  isAdmin?: boolean
  onOpenProjectSettings?: () => void
}) {
  // 分类顺序即 rail 顺序：需求 → Files → 脚本 → 日志 → 用例 → 归档 → 帮助
  const cats: { k: Cat; label: string; icon: React.ReactNode; badge: number }[] = [
    { k: 'req', label: '需求', icon: <FileTextOutlined />, badge: 0 },
    { k: 'code', label: 'Files', icon: <FolderOutlined />, badge: flow?.change_sets.files ?? 0 },
    { k: 'script', label: '脚本', icon: <CodeOutlined />, badge: 0 },
    { k: 'logs', label: '日志', icon: <FileSearchOutlined />, badge: 0 },
    { k: 'cases', label: '用例', icon: <ExperimentOutlined />, badge: flow?.cases.failed ?? 0 },
    { k: 'arch', label: '归档', icon: <InboxOutlined />, badge: 0 },
    { k: 'help', label: '帮助', icon: <QuestionCircleOutlined />, badge: 0 },
  ]

  return (
    <div className="wfa">
      <div className="wfa-rail">
        {cats.map((c) => (
          <button
            key={c.k}
            type="button"
            className={`wfa-rail-item${cat === c.k ? ' is-active' : ''}`}
            onClick={() => onCatChange(c.k)}
          >
            <span className="wfa-rail-icon">
              {c.badge > 0 ? (
                <Badge count={c.badge} size="small" color="#f54a45" offset={[5, -3]}>
                  {c.icon}
                </Badge>
              ) : (
                c.icon
              )}
            </span>
            <span className="wfa-rail-label">{c.label}</span>
          </button>
        ))}
      </div>

      <div className="wfa-main">
        <CatPaneContent
          cat={cat}
          token={token}
          pid={pid}
          rid={rid}
          requirement={requirement}
          flow={flow}
          cases={cases}
          casesLoading={casesLoading}
          diskPath={diskPath}
          sessionId={sessionId}
          refreshSignal={refreshSignal}
          busy={busy}
          onDocSaved={onDocSaved}
          onReloadCases={onReloadCases}
          onReverted={onReverted}
          onAskAgent={onAskAgent}
          onUseCommand={onUseCommand}
          onCatChange={onCatChange}
          isAdmin={isAdmin}
          onOpenProjectSettings={onOpenProjectSettings}
        />
      </div>
    </div>
  )
}
