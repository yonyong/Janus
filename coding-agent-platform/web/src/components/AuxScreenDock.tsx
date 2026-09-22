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

/**
 * 钉在工作台的副屏：
 * - 展开时接近全屏（盖住主工作区），底部始终保留副屏标签条
 * - 点标签可唤出；点已激活标签再次最小化
 */
export default function AuxScreenDock({
  instances,
  onChange,
  onClose,
  onToggleMinimize,
  onActivate,
  ctx,
}: {
  instances: AuxScreenInstance[]
  onChange: (id: string, patch: Partial<AuxScreenInstance>) => void
  onClose: (id: string) => void
  onToggleMinimize: (id: string) => void
  /** 点未激活标签：展开该副屏（并收起其它展开的） */
  onActivate: (id: string) => void
  ctx: PaneCtx
}) {
  const docked = instances.filter((x) => x.mode === 'docked')
  if (!docked.length) return null

  const open = docked.filter((x) => !x.minimized)

  return (
    <div className={`aux-dock-root${open.length ? ' is-expanded' : ''}`}>
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

      {/* 底部标签始终展示：再次点击已激活标签可最小化 */}
      <div className="aux-chip-bar">
        {docked.map((inst, i) => {
          const active = !inst.minimized
          return (
            <button
              key={inst.id}
              type="button"
              className={`aux-chip${active ? ' is-active' : ''}`}
              title={active ? '再次点击最小化' : '唤出副屏'}
              onClick={() => (active ? onToggleMinimize(inst.id) : onActivate(inst.id))}
            >
              {auxLabel(inst, i)}
            </button>
          )
        })}
      </div>
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
