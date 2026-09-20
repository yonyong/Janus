import { useState } from 'react'
import {
  ExperimentOutlined,
  FolderOutlined,
  HistoryOutlined,
  InboxOutlined,
  FileTextOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons'
import { Badge } from 'antd'
import type { Requirement, Stage, TestCase, WorkflowState } from '../api'
import RequirementDocPane from './RequirementDocPane'
import CasePane from './CasePane'
import ArchivePane from './ArchivePane'
import FilePane from './FilePane'
import ChangePane from './ChangePane'
import HelpPanel from './HelpPanel'

/**
 * 左栏固定文件区：竖向分类页签（需求文档 / 用例 / 归档 / 项目文件 / 帮助）+
 * 分类内的横向子页签。不再随阶段整体切换 —— 阶段只决定默认落在哪个分类。
 * 需求目录按 .janus/{dir}/ 存储规范映射：requirement/、usecase/、arch/。
 * 分类由父组件受控（Workbench owns cat），以支持快捷键切换（Alt+1~5）。
 */
export type Cat = 'req' | 'cases' | 'arch' | 'code' | 'help'

export const STAGE_CAT: Record<Stage, Cat> = {
  clarify: 'req',
  verify: 'cases',
  build: 'code',
  archive: 'arch',
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
}) {
  // 编码实现分类内的横向子页签（文件 / 改动；测试与编码事件流已移除，
  // 测试结论看用例状态与归档汇总，编码事件看改动集，不再重复展示）
  const [codeTab, setCodeTab] = useState<'files' | 'changes'>('files')

  // 分类顺序即 rail 顺序：需求文档 → 用例 → 归档 → 项目文件 → 帮助（item 9）
  const cats: { k: Cat; label: string; icon: React.ReactNode; badge: number }[] = [
    { k: 'req', label: '需求文档', icon: <FileTextOutlined />, badge: 0 },
    { k: 'cases', label: '用例', icon: <ExperimentOutlined />, badge: flow?.cases.failed ?? 0 },
    { k: 'arch', label: '归档', icon: <InboxOutlined />, badge: 0 },
    { k: 'code', label: '项目文件', icon: <FolderOutlined />, badge: flow?.change_sets.files ?? 0 },
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
              {/* 角标挂在图标右上角，不用绝对定位盖文字（rail 宽度小，压在文字上会挤压） */}
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
        {cat === 'req' && (
          <RequirementDocPane token={token} pid={pid} requirement={requirement} onSaved={onDocSaved} />
        )}

        {cat === 'cases' && (
          <CasePane
            token={token}
            rid={rid}
            cases={cases}
            loading={casesLoading}
            onReload={onReloadCases}
            onAskAgent={onAskAgent}
          />
        )}

        {cat === 'arch' && (
          <ArchivePane
            token={token}
            rid={rid}
            flow={flow}
            cases={cases}
            onReload={(silent) => onReloadCases(silent)}
          />
        )}

        {cat === 'code' && (
          <div className="wb-tabs">
            {/* 自定义 pill 页签：窄窗口下也永远全可见（antd Tabs 会把溢出的折叠进「…」） */}
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
        )}

        {cat === 'help' && (
          <HelpPanel dir={requirement?.dir_name || ''} busy={busy} onUse={onUseCommand} />
        )}
      </div>
    </div>
  )
}
