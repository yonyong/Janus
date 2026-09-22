import { Button, Select, Space, Typography } from 'antd'
import {
  CloseOutlined,
  CompressOutlined,
  ExpandOutlined,
} from '@ant-design/icons'
import { AUX_TAB_OPTIONS, CatPaneContent, type AuxTab } from './FileWorkArea'
import type { AuxScreenInstance } from './auxScreen'
import { auxLabel } from './auxScreen'
import type { Requirement, TestCase, WorkflowState } from '../api'

type PaneCtx = {
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
  isAdmin?: boolean
  onOpenProjectSettings?: () => void
}

function AuxHalf({
  value,
  onChange,
  ctx,
}: {
  value: AuxTab
  onChange: (v: AuxTab) => void
  ctx: PaneCtx
}) {
  return (
    <div className="aux-half">
      <div className="aux-half-bar">
        <Select
          size="small"
          style={{ minWidth: 110 }}
          value={value}
          options={AUX_TAB_OPTIONS}
          onChange={onChange}
        />
      </div>
      <div className="aux-half-body">
        <CatPaneContent cat={value} {...ctx} onCatChange={() => {}} />
      </div>
    </div>
  )
}

/** 钉在工作台的副屏：底栏窗 + 最小化芯片。 */
export default function AuxScreenDock({
  instances,
  onChange,
  onClose,
  onToggleMinimize,
  ctx,
}: {
  instances: AuxScreenInstance[]
  onChange: (id: string, patch: Partial<AuxScreenInstance>) => void
  onClose: (id: string) => void
  onToggleMinimize: (id: string) => void
  ctx: PaneCtx
}) {
  const docked = instances.filter((x) => x.mode === 'docked')
  if (!docked.length) return null

  const chips = docked.filter((x) => x.minimized)
  const open = docked.filter((x) => !x.minimized)

  return (
    <div className="aux-dock-root">
      {chips.length > 0 && (
        <div className="aux-chip-bar">
          {chips.map((inst, i) => (
            <button
              key={inst.id}
              type="button"
              className="aux-chip"
              onClick={() => onToggleMinimize(inst.id)}
              title="唤出副屏"
            >
              {auxLabel(inst, docked.indexOf(inst))}
            </button>
          ))}
        </div>
      )}
      {open.map((inst) => (
        <div key={inst.id} className="aux-dock-window">
          <div className="aux-dock-title">
            <Typography.Text strong style={{ fontSize: 12 }}>
              {auxLabel(inst, docked.indexOf(inst))}
            </Typography.Text>
            <Space size={4}>
              <Button
                size="small"
                type="text"
                icon={<CompressOutlined />}
                title="最小化"
                onClick={() => onToggleMinimize(inst.id)}
              />
              <Button
                size="small"
                type="text"
                danger
                icon={<CloseOutlined />}
                title="关闭"
                onClick={() => onClose(inst.id)}
              />
            </Space>
          </div>
          <div className="aux-dock-body">
            <AuxHalf
              value={inst.left}
              onChange={(left) => onChange(inst.id, { left })}
              ctx={ctx}
            />
            <div className="aux-dock-split" />
            <AuxHalf
              value={inst.right}
              onChange={(right) => onChange(inst.id, { right })}
              ctx={ctx}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 弹出页内的左右副屏壳。 */
export function AuxScreenFrame({
  left,
  right,
  onLeft,
  onRight,
  title,
  ctx,
}: {
  left: AuxTab
  right: AuxTab
  onLeft: (v: AuxTab) => void
  onRight: (v: AuxTab) => void
  title: string
  ctx: PaneCtx
}) {
  return (
    <div className="aux-popup-root">
      <div className="aux-popup-top">
        <Typography.Text strong>{title}</Typography.Text>
        <Button size="small" icon={<ExpandOutlined />} onClick={() => window.close()}>
          关闭
        </Button>
      </div>
      <div className="aux-popup-body">
        <AuxHalf value={left} onChange={onLeft} ctx={ctx} />
        <div className="aux-dock-split" />
        <AuxHalf value={right} onChange={onRight} ctx={ctx} />
      </div>
    </div>
  )
}
