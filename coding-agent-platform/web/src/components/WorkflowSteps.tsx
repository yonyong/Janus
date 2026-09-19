import { Badge, Button, Steps, Tooltip, Typography } from 'antd'
import {
  CheckCircleOutlined,
  CodeOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  InboxOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import type { Stage, WorkflowState } from '../api'

export const STAGE_ORDER: Stage[] = ['clarify', 'verify', 'build', 'archive']

export const STAGE_META: Record<Stage, { label: string; hint: string; icon: React.ReactNode }> = {
  clarify: { label: '需求澄清', hint: '原始需求 + 详细设计 + 附件，写清要做什么', icon: <FileTextOutlined /> },
  verify: { label: '用例配置', hint: 'AI 生成或手动配置用例与附件，作为验收与单测依据', icon: <ExperimentOutlined /> },
  build: { label: '编码实现', hint: '对话驱动 Agent 按设计文档改代码、执行配置的单测', icon: <CodeOutlined /> },
  archive: { label: '归档验收', hint: '汇总改动与结论，留档', icon: <InboxOutlined /> },
}

/** 每个阶段的「进度摘要」，让步骤条不只显示位置，还能看出这步做完了没。 */
function stageSummary(stage: Stage, flow: WorkflowState | null): { text: string; done: boolean } {
  if (!flow) return { text: '', done: false }
  const c = flow.cases
  switch (stage) {
    case 'clarify': {
      const n = (flow.requirement?.description || '').trim().length
      if (!n) return { text: '待补充文档', done: false }
      const v = flow.versions || 1
      return { text: `文档 ${n} 字${v > 1 ? ` · ${v} 个版本` : ''}`, done: true }
    }
    case 'build': {
      const s = flow.sessions.length
      if (!s) return { text: '尚未开始', done: false }
      // 优先用平台自己记的改动（非 git 项目也有），拿不到再退回 git 视角
      const files = flow.change_sets?.files ?? 0
      const git = flow.changes.available ? flow.changes.files.length : 0
      const n = files || git
      return {
        text: `${s} 次会话${n ? ` · 改动 ${n} 个文件` : ''}`,
        done: s > 0 && n > 0,
      }
    }
    case 'verify': {
      if (!c.total) return { text: '待配置用例', done: false }
      return { text: `${c.total} 条用例${c.failed ? ` · 失败 ${c.failed}` : ''}`, done: c.total > 0 && c.failed === 0 && c.pending === 0 }
    }
    case 'archive': {
      if (flow.verdict === 'accepted') return { text: '验收通过', done: true }
      if (flow.verdict === 'rejected') return { text: '已打回', done: true }
      return { text: '待验收', done: false }
    }
  }
}

/**
 * 轻量模式（requirement.mode === 'lite'）的步骤条：主轴收窄为
 * 「定义（可选）→ 编码实现 → 归档验收」三格。澄清与用例降级为定义节点下的
 * 补做入口——跳过是常态、补做是例外；归档入口常驻，不强制先完成前置。
 * stage 存储不变（仍是四阶段枚举），只有顶部这一条的渲染形态不同。
 */
function LiteSteps({
  stage,
  flow,
  busy,
  onChange,
}: {
  stage: Stage
  flow: WorkflowState
  busy?: boolean
  onChange: (s: Stage) => void
}) {
  const c = flow.cases
  const docChars = (flow.requirement?.description || '').trim().length
  const hasDefine = docChars > 0 || c.total > 0
  // 定义节点：澄清/用例都归它管；两者都没启用时呈虚线「未启用」态
  const defineActive = stage === 'clarify' || stage === 'verify'
  const build = stageSummary('build', flow)
  const archive = stageSummary('archive', flow)

  return (
    <div className="wb-lite-steps">
      <div
        className={`wb-lite-node${defineActive ? ' active' : ''}${hasDefine ? ' done' : ' skipped'}`}
        onClick={() => !busy && onChange(stage === 'verify' ? 'verify' : 'clarify')}
        title="需求澄清与用例配置：轻量模式下可跳过，点这里补做"
      >
        <div className="wb-lite-line" />
        <div className="wb-lite-dot">
          {defineActive ? <FileTextOutlined /> : hasDefine ? '✓' : <FileTextOutlined />}
        </div>
        <div className="wb-lite-lbl">
          定义<span className="wb-lite-opt">（可选）</span>
        </div>
        <div className="wb-lite-desc">
          {hasDefine
            ? `文档 ${docChars} 字${c.total ? ` · ${c.total} 条用例` : ''}`
            : '仅原始需求描述'}
        </div>
        {!hasDefine && <span className="wb-lite-skip">澄清 · 用例 未启用</span>}
        <div className="wb-lite-pills" onClick={(e) => e.stopPropagation()}>
          <Button size="small" type="dashed" disabled={busy} onClick={() => onChange('clarify')}>
            <PlusOutlined /> 补做澄清
          </Button>
          <Button size="small" type="dashed" disabled={busy} onClick={() => onChange('verify')}>
            <PlusOutlined /> 补配用例
          </Button>
        </div>
      </div>
      <div
        className={`wb-lite-node${stage === 'build' ? ' active' : ''}${build.done ? ' done' : ''}`}
        onClick={() => !busy && onChange('build')}
      >
        <div className="wb-lite-line" />
        <div className="wb-lite-dot">{stage === 'build' ? <CodeOutlined /> : build.done ? '✓' : <CodeOutlined />}</div>
        <div className="wb-lite-lbl">编码实现</div>
        <div className="wb-lite-desc">{build.text || '尚未开始'}</div>
      </div>
      <div
        className={`wb-lite-node${stage === 'archive' ? ' active' : ''}${archive.done ? ' done' : ''}`}
        onClick={() => !busy && onChange('archive')}
      >
        <div className="wb-lite-line" />
        <div className="wb-lite-dot">{stage === 'archive' ? <InboxOutlined /> : archive.done ? '✓' : <InboxOutlined />}</div>
        <div className="wb-lite-lbl">归档验收</div>
        <div className="wb-lite-desc">{archive.text || '可随时归档'}</div>
      </div>
    </div>
  )
}

/** 工作台顶部的工作流节点：四阶段可点切换，右侧显示当前阶段该做什么。 */
export default function WorkflowSteps({
  stage,
  flow,
  busy,
  onChange,
  trailing,
}: {
  stage: Stage
  flow: WorkflowState | null
  /** Agent 运行中时禁止切换阶段，避免上下文错位。 */
  busy?: boolean
  onChange: (s: Stage) => void
  trailing?: React.ReactNode
}) {
  // 轻量需求：三节点主轴（定义 → 实现 → 归档），补做入口挂在定义节点下
  if (flow?.requirement?.mode === 'lite') {
    return (
      <div className="wb-flow">
        <LiteSteps stage={stage} flow={flow} busy={busy} onChange={onChange} />
        <div className="wb-flow-side">
          <Tooltip title={STAGE_META[stage].hint}>
            <Typography.Text type="secondary" className="wb-flow-hint">
              当前：{STAGE_META[stage].label}（轻量）
            </Typography.Text>
          </Tooltip>
          {trailing}
        </div>
      </div>
    )
  }

  const idx = Math.max(0, STAGE_ORDER.indexOf(stage))
  const items = STAGE_ORDER.map((key) => {
    const meta = STAGE_META[key]
    const sum = stageSummary(key, flow)
    return {
      title: (
        <span className="wb-flow-title">
          {meta.label}
          {sum.done && <CheckCircleOutlined className="wb-flow-done" />}
        </span>
      ),
      description: (
        <span className="wb-flow-desc">
          {sum.text || meta.hint}
          {key === 'verify' && flow?.cases?.failed ? (
            <Badge count={`${flow.cases.failed} 未过`} size="small" color="#f54a45" />
          ) : null}
        </span>
      ),
      icon: meta.icon,
      disabled: !!busy,
    }
  })

  return (
    <div className="wb-flow">
      <Steps
        className="wb-flow-steps"
        size="small"
        current={idx}
        items={items}
        onChange={(i) => {
          if (busy) return
          const next = STAGE_ORDER[i]
          if (next && next !== stage) onChange(next)
        }}
      />
      <div className="wb-flow-side">
        <Tooltip title={STAGE_META[stage].hint}>
          <Typography.Text type="secondary" className="wb-flow-hint">
            当前：{STAGE_META[stage].label}
          </Typography.Text>
        </Tooltip>
        {trailing}
      </div>
    </div>
  )
}
