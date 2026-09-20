import { useState } from 'react'
import {
  CheckCircleFilled,
  DownOutlined,
  ThunderboltFilled,
} from '@ant-design/icons'
import type { Stage, WorkflowState } from '../api'

/**
 * 流程指令清单：替代旧顶部步骤条的「流程感知」入口。
 * 全部指令跨阶段按推荐顺序连续编号；已完成的打绿标，下一个建议执行的蓝框高亮。
 * 点击指令 = 切到对应阶段上下文 + 把指令文本灌入输入框（由用户手动发送）。
 * 「已完成」由平台按产出自动判定：文档字数 / 版本数 / 用例数 / 改动文件数 / 用例执行 / 验收结论。
 */
export interface FlowCommand {
  stage: Stage
  label: string
  desc: string
  text: string
}

/** 各阶段指令（与原快捷指令同一段话术；路径按需求目录动态生成，Agent 不用猜）。 */
const buildClarifyCommands = (dir: string): FlowCommand[] => {
  const base = dir ? `.janus/${dir}` : '.janus'
  return [
    {
      stage: 'clarify',
      label: '润色需求文档',
      desc: 'Agent 读取原始需求文档，润色后写回原文件',
      text:
        `请阅读项目目录下的 ${base}/requirement/origin.md（原始需求文档），` +
        '把它润色成结构清晰、可直接执行的中文 Markdown 需求说明：' +
        '用「背景 / 目标 / 功能点 / 验收要点」组织内容，保留原意与全部关键信息，' +
        '信息不全用「待确认」标注，不要臆测功能；' +
        `把润色后的全文写回 ${base}/requirement/origin.md，并在回复中给出全文。`,
    },
    {
      stage: 'clarify',
      label: '生成详细设计',
      desc: 'Agent 通读需求、附件与项目代码，产出详细设计文档',
      text:
        `请先阅读项目目录下的 ${base}/requirement/origin.md（原始需求文档），浏览项目目录与相关代码，` +
        '并阅读需求附件（如 .janus 需求目录的 requirement/attach/ 下有附件），产出一份详细设计文档，' +
        '供编码 Agent 照着实现：必须包含「背景与目标、现状分析、总体方案、涉及文件清单、实现步骤、测试与验证方式」小节，' +
        '方案落到具体文件与函数级别，信息不全用「待确认」标注；' +
        `把文档全文写入 ${base}/requirement/design.md，并在回复中给出全文。`,
    },
  ]
}

/** 用例草稿指令：对话结束平台自动把 cases-draft.md 导入用例列表。 */
export const verifyCasesPrompt = (dir: string): string => {
  const base = dir ? `.janus/${dir}` : '.janus'
  return (
    `请先阅读项目目录下的 ${base}/requirement/origin.md（原始需求文档）与 ${base}/requirement/design.md（详细设计文档，若存在），` +
    '以资深测试工程师视角设计功能验证用例：覆盖主流程、边界与异常路径，每条只验证一个点，标题简洁明确；' +
    '把用例以一个 ```json 代码块（对象数组，字段固定为 title / steps / expected，steps 多步用换行分隔）' +
    `写入 ${base}/usecase/cases-draft.md（文件内容只有这个代码块，不要写其他内容）；` +
    '写完后在回复里逐条列出用例标题（平台会在对话结束后把草稿自动导入用例列表）。'
  )
}

const buildCommands = (dir: string): FlowCommand[] => {
  const base = dir ? `.janus/${dir}` : '.janus'
  return [
    ...buildClarifyCommands(dir),
    {
      stage: 'verify',
      label: '生成单测用例',
      desc: 'Agent 生成用例草稿，对话结束自动导入用例列表',
      text: verifyCasesPrompt(dir),
    },
    {
      stage: 'build',
      label: '按设计文档实现需求',
      desc: '先读需求与设计文档实现，再逐条执行配置的单测',
      text:
        `请先阅读项目目录下的 ${base}/requirement/origin.md（原始需求文档）与 ${base}/requirement/design.md（详细设计文档），` +
        '严格按详细设计文档实现这个需求，不要改动与该需求无关的其他文件；' +
        `实现过程中的说明性文档（实现说明、决策记录等）写入 ${base}/other/ 目录；` +
        `实现完成后，按 ${base}/usecase/usercase.md 中配置的单测逐条执行，确保全部验证通过；` +
        '执行结果用 Markdown 表格逐条记录（表头：用例 | 标题 | 结果 | 说明，结果列只能取：通过 / 失败 / 跳过 / 未执行），' +
        `写入 ${base}/arch/test-result.md——平台会解析该表格自动回写用例状态，务必严格按表格格式输出。`,
    },
    {
      stage: 'build',
      label: '执行配置的单测',
      desc: '跑全部单测，汇总测试报告并回写用例状态',
      text:
        `请执行项目目录下 ${base}/usecase/usercase.md 中配置的全部单测，逐条运行并确保验证通过；` +
        '只处理与这些用例相关的文件，完成后把每条用例的执行结果用 Markdown 表格逐条汇总' +
        '（表头：用例 | 标题 | 结果 | 说明，结果列只能取：通过 / 失败 / 跳过 / 未执行），' +
        `写入 ${base}/arch/test-result.md——平台会解析该表格自动回写用例状态，务必严格按表格格式输出，并向我汇报结论。`,
    },
    {
      stage: 'archive',
      label: '归档验收',
      desc: '查看测试报告，给出验收结论并归档留痕',
      text: '',
    },
  ]
}

export { buildCommands as buildFlowCommands }

/** 平台按产出自动判定指令是否已完成（不依赖用户手动打卡）。 */
function commandDone(cmd: FlowCommand, flow: WorkflowState | null): boolean {
  if (!flow) return false
  const c = flow.cases
  switch (cmd.label) {
    case '润色需求文档':
      return (flow.requirement?.description || '').trim().length > 0
    case '生成详细设计':
      return flow.versions > 1
    case '生成单测用例':
      return c.total > 0
    case '按设计文档实现需求':
      return (
        (flow.change_sets?.files ?? 0) > 0 ||
        (flow.changes.available && flow.changes.files.length > 0)
      )
    case '执行配置的单测':
      return c.passed + c.failed > 0
    case '归档验收':
      return flow.verdict === 'accepted'
    default:
      return false
  }
}

const GROUP_LABELS: Record<Stage, string> = {
  clarify: '需求澄清',
  verify: '用例配置',
  build: '编码实现',
  archive: '归档验收',
}

export default function FlowCommands({
  stage,
  flow,
  dir,
  busy,
  onUse,
}: {
  stage: Stage
  flow: WorkflowState | null
  /** 需求目录名（.janus/{dir}/...），指令话术里用。 */
  dir: string
  busy?: boolean
  /** 点击指令：切阶段上下文 + 灌入输入框。归档指令 text 为空时仅切阶段。 */
  onUse: (cmd: FlowCommand) => void
}) {
  const [open, setOpen] = useState(false)
  const cmds = buildCommands(dir)
  let n = 0
  const rows = cmds.map((cmd) => {
    n += 1
    const done = commandDone(cmd, flow)
    return { cmd, n, done }
  })
  // 建议下一步：顺序里第一条未完成的指令（全部完成则不高亮）
  const nextLabel = rows.find((r) => !r.done)?.cmd.label

  // 按阶段分组渲染（顺序即编号顺序）
  const groups: Stage[] = ['clarify', 'verify', 'build', 'archive']
  return (
    <div className={`flow-cmds${open ? '' : ' closed'}`}>
      <button type="button" className="fc-head" onClick={() => setOpen(!open)}>
        <ThunderboltFilled className="fc-head-icon" />
        <span className="fc-head-title">流程指令</span>
        <span className="fc-head-hint">按推荐顺序执行 · 已完成自动打标</span>
        <DownOutlined className="fc-head-caret" />
      </button>
      {open && (
        <div className="fc-body">
          {groups.map((g) => {
            const items = rows.filter((r) => r.cmd.stage === g)
            if (!items.length) return null
            const body = items.map(({ cmd, n: idx, done }) => {
              const isNext = !done && cmd.label === nextLabel
              const st = done ? (
                <span className="fc-st is-done">
                  <CheckCircleFilled /> 已完成
                </span>
              ) : isNext ? (
                <span className="fc-st is-next">建议下一步</span>
              ) : (
                <span className="fc-st is-todo">待执行</span>
              )
              return (
                <button
                  key={cmd.label}
                  type="button"
                  className={`fc-row${done ? ' is-done' : ''}${isNext ? ' is-next' : ''}`}
                  disabled={busy}
                  title={cmd.desc}
                  onClick={() => onUse(cmd)}
                >
                  <span className="fc-num">{idx}</span>
                  <span className="fc-name">{cmd.label}</span>
                  <span className="fc-desc">{cmd.desc}</span>
                  {st}
                </button>
              )
            })
            return (
              <div key={g}>
                <div className="fc-group">
                  {GROUP_LABELS[g]}
                  {stage === g && <span className="fc-group-cur">当前阶段</span>}
                </div>
                {body}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
