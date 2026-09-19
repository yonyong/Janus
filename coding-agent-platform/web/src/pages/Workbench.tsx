import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { App as AntdApp, Badge, Button, Dropdown, Space, Tag, Typography } from 'antd'
import {
  ArrowLeftOutlined,
  CodeOutlined,
  DownOutlined,
  ExperimentOutlined,
  FolderOutlined,
  HistoryOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { useToken } from '../auth'
import {
  Message,
  Requirement,
  ReqMode,
  SessionDetail,
  Stage,
  TestCase,
  WorkflowState,
  abortSessionRun,
  createSession,
  describeError,
  importCasesFromWorkspace,
  listCases,
  listRequirements,
  requirementWorkflow,
  sessionActiveRun,
  sessionDetail,
  sessionMessages,
  setRequirementStage,
  streamEvents,
  updateRequirement,
} from '../api'
import type { QuickCommand, RequirementPaneHandle } from '../components/RequirementPane'
import WorkflowSteps from '../components/WorkflowSteps'
import RequirementDocPane from '../components/RequirementDocPane'
import CasePane from '../components/CasePane'
import ArchivePane from '../components/ArchivePane'
import FilePane from '../components/FilePane'
import ChangePane from '../components/ChangePane'
import RequirementPane from '../components/RequirementPane'
import CodePane from '../components/CodePane'
import TestPane from '../components/TestPane'

/**
 * 需求澄清阶段的常用指令：与编码阶段同款引导卡，把原来「AI 润色」「AI 生成设计」
 * 两个一次性按钮改成走对话——结果直接落到工作区规范路径，
 * 编辑器实时轮询工作区自动载入最新内容，无需手动同步。
 */
const buildClarifyQuickCommands = (dir: string): QuickCommand[] => {
  const base = dir ? `.janus/${dir}` : '.janus'
  return [
    {
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

/**
 * 用例配置阶段的常用指令：对话流式输出没有超时上限，慢模型也能跑完。
 * Agent 把用例草稿（```json 数组）写进工作区 cases-draft.md，对话结束后平台
 * 自动把草稿导入用例列表（同名条目跳过，导入即删草稿）。
 */
/** 生成用例的完整指令（快捷指令与用例空态的「一键生成用例」共用同一段话术）。 */
const verifyCasesPrompt = (dir: string): string => {
  const base = dir ? `.janus/${dir}` : '.janus'
  return (
    `请先阅读项目目录下的 ${base}/requirement/origin.md（原始需求文档）与 ${base}/requirement/design.md（详细设计文档，若存在），` +
    '以资深测试工程师视角设计功能验证用例：覆盖主流程、边界与异常路径，每条只验证一个点，标题简洁明确；' +
    '把用例以一个 ```json 代码块（对象数组，字段固定为 title / steps / expected，steps 多步用换行分隔）' +
    `写入 ${base}/usecase/cases-draft.md（文件内容只有这个代码块，不要写其他内容）；` +
    '写完后在回复里逐条列出用例标题（平台会在对话结束后把草稿自动导入用例列表）。'
  )
}

const buildVerifyQuickCommands = (dir: string): QuickCommand[] => {
  return [
    {
      label: '生成单测用例',
      desc: 'Agent 通读需求与设计文档，把用例草稿写入工作区，结束后自动导入用例列表',
      text: verifyCasesPrompt(dir),
    },
  ]
}

/**
 * 编码实现阶段的常用指令：路径按需求目录动态生成（.janus/{需求目录}/...，
 * 目录名 = 需求名称，创建后固定），Agent 按路径直接读，避免它去猜
 * 「设计文档」「配置的单测」是哪些文件。
 * 后端在保存文档 / 配置用例时已把这些文件镜像到 .janus/ 下（见 backend/docs.py）。
 */
const buildQuickCommands = (dir: string): QuickCommand[] => {
  const base = dir ? `.janus/${dir}` : '.janus'
  return [
    {
      label: '按设计文档实现需求',
      desc: 'Agent 先读需求文档与设计文档，实现后逐条执行配置的单测',
      text:
        `请先阅读项目目录下的 ${base}/requirement/origin.md（原始需求文档）与 ${base}/requirement/design.md（详细设计文档），` +
        '严格按详细设计文档实现这个需求，不要改动与该需求无关的其他文件；' +
        `实现过程中的说明性文档（实现说明、决策记录等）写入 ${base}/other/ 目录；` +
        `实现完成后，按 ${base}/usecase/usercase.md 中配置的单测逐条执行，确保全部验证通过；` +
        `执行结果用 Markdown 表格逐条记录（表头：用例 | 标题 | 结果 | 说明，结果列只能取：通过 / 失败 / 跳过 / 未执行），` +
        `写入 ${base}/arch/test-result.md——平台会解析该表格自动回写用例状态，务必严格按表格格式输出。`,
    },
    {
      label: '执行配置的单测',
      desc: '跑用例配置里的全部单测，汇总测试报告并汇报结论',
      text:
        `请执行项目目录下 ${base}/usecase/usercase.md 中配置的全部单测，逐条运行并确保验证通过；` +
        '只处理与这些用例相关的文件，完成后把每条用例的执行结果用 Markdown 表格逐条汇总' +
        '（表头：用例 | 标题 | 结果 | 说明，结果列只能取：通过 / 失败 / 跳过 / 未执行），' +
        `写入 ${base}/arch/test-result.md——平台会解析该表格自动回写用例状态，务必严格按表格格式输出，并向我汇报结论。`,
    },
  ]
}

/**
 * 沉浸式工作台：顶部是工作流节点（需求澄清 → 用例配置 → 编码实现 → 归档验收），
 * 左侧随阶段切换（双文档 / 用例配置 / 文件树 / 归档汇总）。
 * 需求澄清、用例配置与编码实现右侧是对话；归档验收是纯操作页（左栏全宽）。
 * 侧边菜单与顶部菜单由 App 在该路由下隐藏，退出靠左上角返回。
 */
export default function Workbench() {
  const { sid } = useParams()
  const sessionId = Number(sid)
  const [params] = useSearchParams()
  const token = useToken()
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()

  const [info, setInfo] = useState<SessionDetail | null>(null)
  const [requirement, setRequirement] = useState<Requirement | null>(null)
  const [flow, setFlow] = useState<WorkflowState | null>(null)
  const [cases, setCases] = useState<TestCase[]>([])
  const [casesLoading, setCasesLoading] = useState(false)
  const [stage, setStage] = useState<Stage>('clarify')
  // 编码实现阶段左栏的当前页签（文件 / 改动 / 测试 / 编码）
  const [buildTab, setBuildTab] = useState<'files' | 'changes' | 'test' | 'code'>('files')
  const [conv, setConv] = useState<{ role: string; content: string }[]>([])
  // 流式输出：一次运行中 Agent 的全部输出（各轮流式正文 + 最终答复）都汇总进
  // 同一条气泡（streamText 实时追加），done 时整体转正为一条对话消息；
  // 刷新后从库里回放最终答复。streamRef 是 streamText 的同步镜像，供事件回调读取最新值。
  const [streamText, setStreamText] = useState('')
  const [statusText, setStatusText] = useState('')
  const streamRef = useRef('')
  const [codeEvents, setCodeEvents] = useState<any[]>([])
  const [testEvents, setTestEvents] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  // Agent 产出改动时自增，用于让文件面板静默刷新
  const [fsSignal, setFsSignal] = useState(0)
  const esRef = useRef<EventSource | null>(null)
  // 用户是否手动点过工作流节点：点过之后，迟到的加载结果不得把阶段覆盖回去
  const stagePicked = useRef(false)
  /** 右侧对话窗格：快捷指令 / 一键生成用例都只灌入输入框，由用户手动发送。 */
  const paneRef = useRef<RequirementPaneHandle | null>(null)

  // 项目 id 优先取会话详情，URL 参数只作兜底（旧链接、详情接口失败时仍能显示文件面板）
  const pidParam = params.get('pid')
  const pid = info?.project_id ?? (pidParam ? Number(pidParam) : null)
  const rid = requirement?.id ?? info?.requirement?.id ?? null

  // ---------------- 数据加载 ----------------

  useEffect(() => {
    let active = true
    const populate = async () => {
      try {
        const detail = await sessionDetail(token, sessionId)
        if (!active) return
        setInfo(detail)
        if (detail.requirement) {
          setRequirement(detail.requirement)
          if (!stagePicked.current) setStage((detail.requirement.stage as Stage) || 'clarify')
        }
      } catch {
        // 详情拿不到时退化为用 URL 上的 pid/rid 拼需求信息
        const rid2 = params.get('rid')
        if (pidParam && rid2) {
          try {
            const reqs = await listRequirements(token, Number(pidParam))
            if (active) setRequirement(reqs.find((r) => String(r.id) === String(rid2)) || null)
          } catch {
            /* 需求信息属锦上添花，失败不影响主流程 */
          }
        }
      }
      try {
        const msgs: Message[] = await sessionMessages(token, sessionId)
        if (!active) return
        const c: { role: string; content: string }[] = []
        const code: any[] = []
        const test: any[] = []
        for (const m of msgs) {
          if (m.role === 'user') {
            c.push({ role: 'user', content: m.content })
          } else if (m.pane === 'code') {
            code.push({ type: 'edit', pane: 'code', text: m.content })
          } else if (m.pane === 'test') {
            test.push({ type: 'test', pane: 'test', text: m.content })
          } else {
            c.push({ role: 'agent', content: m.content })
          }
        }
        setConv(c)
        setCodeEvents(code)
        setTestEvents(test)
      } catch (e: any) {
        if (active) setConv([{ role: 'agent', content: '加载失败：' + String(e.message || e) }])
      }
    }
    populate()
    return () => {
      active = false
      esRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, token])

  // 刷新 / 重进页面后，若该会话仍有后台 run 在跑（页面刷新不会杀死它），
  // 立即重新订阅把流式输出接回来，而不是等它跑完后才从历史记录里看到结果。
  useEffect(() => {
    void recover()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, token])

  /** 工作流看板：阶段、用例统计、会话数、改动文件、验收结论。 */
  const loadFlow = useCallback(
    async (silent = false) => {
      if (rid === null) return
      try {
        const f = await requirementWorkflow(token, rid)
        setFlow(f)
        if (f.requirement) setRequirement(f.requirement as Requirement)
        // 用户已经点过节点时不要覆盖：否则刚点开工作台就切阶段，会被这次迟到的
        // 加载结果弹回数据库里的旧阶段（左栏整个换掉，看起来像「点了没反应」）。
        if (!silent && !stagePicked.current) setStage((f.stage as Stage) || 'clarify')
      } catch (e) {
        if (!silent) {
          const info2 = describeError(e)
          message.error(`${info2.title}${info2.detail ? '：' + info2.detail : ''}`)
        }
      }
    },
    [message, rid, token],
  )

  const loadCases = useCallback(
    async (silent = false) => {
      if (rid === null) return
      if (!silent) setCasesLoading(true)
      try {
        setCases(await listCases(token, rid))
      } catch (e) {
        const i = describeError(e)
        message.error(`${i.title}${i.detail ? '：' + i.detail : ''}`)
      } finally {
        if (!silent) setCasesLoading(false)
      }
    },
    [message, rid, token],
  )

  useEffect(() => {
    if (rid === null) return
    void loadFlow()
    void loadCases(true)
  }, [rid, loadFlow, loadCases])

  // ---------------- 步骤引导 ----------------

  // 当前阶段的快捷指令（同时用于把发出的指令文本映射回 label，供完成后给出下一步引导）
  const quickCommands = useMemo(() => {
    const dir = requirement?.dir_name || ''
    if (stage === 'build') return buildQuickCommands(dir)
    if (stage === 'verify') return buildVerifyQuickCommands(dir)
    return buildClarifyQuickCommands(dir)
  }, [stage, requirement?.dir_name])

  // 一次运行结束后的下一步引导：文本 + 可选的「进入下一环节」按钮 / 高亮的快捷指令。
  // 发送新消息或切换阶段时清除。
  const [stepHint, setStepHint] = useState<{
    text: string
    actionLabel?: string
    actionStage?: Stage
    highlight?: string
  } | null>(null)

  const stepHintAfterDone = useCallback((stageAtSend: Stage, label: string) => {
    if (stageAtSend === 'clarify') {
      if (label === '润色需求文档') {
        setStepHint({ text: '需求文档已润色完成，接下来建议「生成详细设计」', highlight: '生成详细设计' })
      } else if (label === '生成详细设计') {
        setStepHint({
          text: '详细设计已生成，可以进入下一环节「用例配置」，为验收配置测试用例',
          actionLabel: '进入用例配置',
          actionStage: 'verify',
        })
      }
    } else if (stageAtSend === 'verify') {
      if (label === '生成单测用例') {
        setStepHint({
          text: '用例草稿已生成并自动导入，确认用例后可进入「编码实现」',
          actionLabel: '进入编码实现',
          actionStage: 'build',
        })
      }
    } else if (stageAtSend === 'build') {
      if (label === '按设计文档实现需求') {
        setStepHint({ text: '实现完成，建议执行「执行配置的单测」验证结果', highlight: '执行配置的单测' })
      } else if (label === '执行配置的单测') {
        setStepHint({
          text: '测试执行完毕，可进入「归档验收」查看需求全貌并归档',
          actionLabel: '进入归档验收',
          actionStage: 'archive',
        })
      }
    }
  }, [])

  const changeStage = async (next: Stage) => {
    const prev = stage
    stagePicked.current = true
    setStepHint(null)
    setStage(next)
    if (rid === null) return
    try {
      const r = await setRequirementStage(token, rid, next)
      setRequirement(r)
      void loadFlow(true)
      if (next === 'verify' || next === 'build') void loadCases(true)
    } catch (e) {
      setStage(prev)
      const i = describeError(e)
      message.error(`${i.title}${i.detail ? '：' + i.detail : ''}`)
    }
  }

  /** 切换工作流模式（标准 / 轻量）：只改渲染形态与归档提示口径，不动阶段与数据。 */
  const [switchingMode, setSwitchingMode] = useState(false)
  const changeMode = async (m: ReqMode) => {
    if (rid === null || requirement?.mode === m) return
    setSwitchingMode(true)
    try {
      const r = await updateRequirement(token, rid, { mode: m })
      setRequirement(r)
      await loadFlow(true)
      message.success(m === 'lite' ? '已切换为轻量流程：澄清与用例变为可选' : '已切换为标准流程')
    } catch (e) {
      const i = describeError(e)
      message.error(`${i.title}${i.detail ? '：' + i.detail : ''}`)
    } finally {
      setSwitchingMode(false)
    }
  }

  const modeMenu = (
    <Dropdown
      trigger={['click']}
      disabled={busy}
      menu={{
        selectable: true,
        selectedKeys: [requirement?.mode === 'lite' ? 'lite' : 'full'],
        items: [
          { key: 'full', label: '标准流程（澄清 → 用例 → 编码 → 归档）' },
          { key: 'lite', label: '轻量流程（定义可选 → 编码 → 归档）' },
        ],
        onClick: ({ key }) => void changeMode(key as ReqMode),
      }}
    >
      <Button size="small" icon={<SwapOutlined />} loading={switchingMode}>
        {requirement?.mode === 'lite' ? '轻量流程' : '标准流程'}
      </Button>
    </Dropdown>
  )

  /**
   * 订阅一次 agent 运行的 SSE 流。用户点击发送与「刷新/断线后续传」共用：
   * 后端以 (session, message) 幂等，重连同一消息会续传同一 run，并从事件 0
   * 完整回放已产生的内容，不会重复调用 agent。
   */
  const runStream = (text: string) => {
    if (esRef.current && esRef.current.readyState === EventSource.OPEN) return
    setBusy(true)
    // 用户消息落库发生在后端 resolve_run；续传场景历史加载已带回该消息，去重防止气泡重复
    setConv((c) =>
      c.some((m) => m.role === 'user' && m.content === text) ? c : [...c, { role: 'user', content: text }],
    )
    streamRef.current = ''
    setStreamText('')
    setStatusText('')
    const stageAtSend = stage
    const label = quickCommands.find((c) => c.text === text)?.label || ''
    const es = streamEvents(sessionId, text, token)
    esRef.current = es
    es.onmessage = async (ev) => {
      let d: any
      try {
        d = JSON.parse(ev.data)
      } catch {
        return
      }
      if (d.type === 'done') {
        es.close()
        setBusy(false)
        setStatusText('')
        // 收口：本次运行的汇总气泡整体转正为一条完整对话消息（无输出则不留空泡）
        const body = streamRef.current.trim()
        if (body) setConv((c) => [...c, { role: 'agent', content: body }])
        streamRef.current = ''
        setStreamText('')
        setFsSignal((n) => n + 1)
        // 步骤引导：快捷指令跑完后提示下一步（刷新续传的运行拿不到 label，静默收尾）
        stepHintAfterDone(stageAtSend, label)
        // 改动文件数 / 会话消息数都在看板里，跑完顺手刷新
        void loadFlow(true)
        // 用例配置阶段：Agent 可能在对话里写了用例草稿（cases-draft.md），
        // 跑完自动导入落库（同名条目跳过；没写草稿时接口 404，静默忽略）
        if (stageAtSend === 'verify' && rid !== null) {
          try {
            const r = await importCasesFromWorkspace(token, rid)
            if (r.created > 0) {
              message.success(
                `已从对话草稿导入 ${r.created} 条用例${r.skipped ? `，跳过 ${r.skipped} 条同名` : ''}`,
              )
              void loadCases(true)
            }
          } catch {
            /* 没有草稿 / 解析失败都属正常，不打断对话收尾 */
          }
        }
        return
      }
      if (d.type === 'error') {
        setConv((c) => [...c, { role: 'agent', content: '错误：' + (d.text || '未知错误') }])
        es.close()
        setBusy(false)
        streamRef.current = ''
        setStreamText('')
        setStatusText('')
        return
      }
      // 流式增量：实时追加进本次运行的唯一汇总气泡（不落库，收口时整体转正）
      if (d.type === 'delta') {
        if (d.text) {
          streamRef.current += d.text
          setStreamText(streamRef.current)
        }
        return
      }
      // 用户主动中止：后端已取消 run 并杀掉 CLI 进程树。把说明并入汇总气泡，
      // 随后的 done 事件负责整体转正与收口（不落库，因此重发同一消息可重跑）。
      if (d.type === 'abort') {
        const note = d.text || '已按你的要求中止本次运行，Agent 进程已被终止'
        streamRef.current = streamRef.current ? `${streamRef.current}\n\n${note}` : note
        setStreamText(streamRef.current)
        setStatusText('')
        return
      }
      // 瞬态状态（调用工具 / 中间过程）：显示为气泡下方的状态行，不打断正在流式的正文
      if (d.type === 'status') {
        setStatusText(d.text || '')
        return
      }
      if (d.type === 'edit' || d.pane === 'code') {
        setCodeEvents((e) => [...e, d])
        setFsSignal((n) => n + 1)
      } else if (d.type === 'test' || d.pane === 'test') {
        setTestEvents((e) => [...e, d])
      } else {
        // 正文类 message：中间轮次（transient）的内容已由 delta 实时展示过，忽略；
        // 最终答复（streamed）是同一段话的权威版本，用整体内容刷新汇总气泡去重；
        // 非流式来源的正文同样并入这条气泡 —— 一次回答永远只占一条消息。
        if (d.payload?.transient) return
        const t = d.text || ''
        streamRef.current = d.payload?.streamed
          ? t
          : streamRef.current
            ? streamRef.current + '\n\n' + t
            : t
        setStreamText(streamRef.current)
        setStatusText('')
      }
    }
    es.onerror = () => {
      // 连接中断：run 还在后台继续跑。不再像以前那样直接丢弃流式内容，
      // 稍候探测 active-run 并重新订阅续传（网络恢复 / 后端重启后的自愈入口）。
      es.close()
      setBusy(false)
      window.setTimeout(() => void recover(), 1500)
    }
  }

  /** 探测该会话是否仍有进行中的 run；有则重新订阅把流接回来。 */
  const recover = async () => {
    if (esRef.current && esRef.current.readyState !== EventSource.CLOSED) return
    try {
      const r = await sessionActiveRun(token, sessionId)
      if (r.active && r.message) runStream(r.message)
    } catch {
      /* 接口不可达（多半网络也断了），等用户刷新页面 */
    }
  }

  const send = (text: string) => {
    if (busy) return
    setStepHint(null)
    runStream(text)
  }

  /** 真中止当前运行：后端取消 run 任务并杀掉 CLI 子进程树，不是只关页面上的 SSE。
   *  中止事件（abort）随后经 SSE 推回，对话里留下「已中止」说明；done 正常收口。 */
  const [aborting, setAborting] = useState(false)
  const abortRun = async () => {
    if (!busy || aborting) return
    setAborting(true)
    try {
      const r = await abortSessionRun(token, sessionId)
      if (!r.aborted) message.info('当前没有正在运行的 Agent')
    } catch (e) {
      const i = describeError(e)
      message.error(`${i.title}${i.detail ? '：' + i.detail : ''}`)
    } finally {
      setAborting(false)
    }
  }

  const back = () => navigate(pid ? `/projects/${pid}` : '/projects')

  // ---------------- 会话切换（新会话 / 从历史会话进入） ----------------

  /** 同需求内切换会话：带上 pid/rid 参数，工作台其他数据随 sid 变化自动重载。 */
  const gotoSession = (targetSid: number) => {
    if (targetSid === sessionId) return
    const qs = new URLSearchParams()
    if (pid !== null) qs.set('pid', String(pid))
    if (rid !== null) qs.set('rid', String(rid))
    navigate(`/workbench/${targetSid}${qs.toString() ? '?' + qs.toString() : ''}`)
  }

  /** 给当前需求开一个新会话并进入（新会话会切一个新工作分支）。 */
  const createNewSession = async () => {
    if (rid === null) return
    try {
      const s = await createSession(token, rid)
      gotoSession(s.id)
    } catch (e) {
      const i = describeError(e)
      message.error(`${i.title}${i.detail ? '：' + i.detail : ''}`)
    }
  }

  // 顶栏「会话 #N」下拉：该需求的全部历史会话（新在前）+ 新建会话入口，
  // 用户随时能看到自己在这个需求下的所有会话并一键切换。
  const sessionMenu = useMemo(() => {
    const items = [...(flow?.sessions ?? [])].reverse().map((s) => ({
      key: `s-${s.id}`,
      label: (
        <span style={s.id === sessionId ? { color: '#3370ff', fontWeight: 600 } : undefined}>
          会话 #{s.id}（{s.messages} 条消息{s.agent ? ` · ${s.agent}` : ''}）
          {s.id === sessionId ? ' · 当前' : ''}
        </span>
      ),
    }))
    return [...items, { type: 'divider' as const }, { key: 'new', icon: <PlusOutlined />, label: '新建会话' }]
  }, [flow, sessionId])

  const onPickSession = ({ key }: { key: string }) => {
    if (key === 'new') {
      void createNewSession()
      return
    }
    const target = Number(key.replace(/^s-/, ''))
    if (Number.isFinite(target)) gotoSession(target)
  }

  const title = requirement?.title || info?.requirement?.title || `会话 #${sid}`

  return (
    <div className="wb-immersive">
      <div className="wb-top">
        <Space size={10} style={{ minWidth: 0 }}>
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={back}>
            返回
          </Button>
          <Typography.Text strong style={{ fontSize: 14 }} ellipsis={{ tooltip: title }}>
            {title}
          </Typography.Text>
          <Space size={6} wrap>
            <Dropdown trigger={['click']} menu={{ items: sessionMenu, onClick: onPickSession }}>
              <Tag
                color="blue"
                style={{ marginInlineEnd: 0, cursor: 'pointer', userSelect: 'none' }}
                title="点击查看该需求的全部会话"
              >
                会话 #{sid} <DownOutlined style={{ fontSize: 10 }} />
              </Tag>
            </Dropdown>
            {info?.project && <Tag style={{ marginInlineEnd: 0 }}>{info.project}</Tag>}
            {(info?.agent || info?.git_branch) && (
              <Tag style={{ marginInlineEnd: 0 }}>
                {info?.agent?.name || 'Agent'}
                {info?.git_branch ? ` · ${info.git_branch}` : ''}
              </Tag>
            )}
          </Space>
        </Space>
        <Space size={10}>
          {busy && (
            <Button
              size="small"
              danger
              icon={<PauseCircleOutlined />}
              loading={aborting}
              onClick={() => void abortRun()}
            >
              停止运行
            </Button>
          )}
          <Tag
            color={busy ? 'processing' : 'default'}
            style={{ marginInlineEnd: 0, borderRadius: 999, paddingInline: 10 }}
          >
            {busy ? 'Agent 运行中' : '空闲'}
          </Tag>
        </Space>
      </div>

      <WorkflowSteps
        stage={stage}
        flow={flow}
        busy={busy}
        onChange={(s) => void changeStage(s)}
        trailing={rid === null ? undefined : modeMenu}
      />

      <div className={`wb-body${stage === 'archive' ? ' wb-solo' : ''}`}>
        <section className="wb-left">
          {stage === 'clarify' && (
            <RequirementDocPane
              token={token}
              pid={pid}
              requirement={requirement}
              onSaved={(r) => {
                setRequirement(r)
                void loadFlow(true)
              }}
            />
          )}

          {stage === 'build' && (
            <div className="wb-tabs">
              {/* 自定义 pill 页签：窄窗口下也永远四个全可见（antd Tabs 会把溢出的
                  「测试/编码」折叠进「…」下拉，用户就找不到它们了） */}
              <div className="wb-tabbar">
                {(
                  [
                    { key: 'files', label: '文件', icon: <FolderOutlined />, badge: 0 },
                    { key: 'changes', label: '改动', icon: <HistoryOutlined />, badge: 0 },
                    { key: 'test', label: '测试', icon: <ExperimentOutlined />, badge: testEvents.length },
                    { key: 'code', label: '编码', icon: <CodeOutlined />, badge: codeEvents.length },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className={`wb-tab${buildTab === t.key ? ' is-active' : ''}`}
                    onClick={() => setBuildTab(t.key)}
                  >
                    <span className="wb-tab-icon">{t.icon}</span>
                    {t.label}
                    {t.badge > 0 && <Badge count={t.badge} color="#3370ff" style={{ marginLeft: 2 }} />}
                  </button>
                ))}
              </div>
              <div className="wb-tabbody">
                {buildTab === 'files' && (
                  <FilePane pid={pid} token={token} diskPath={info?.disk_path} refreshSignal={fsSignal} />
                )}
                {buildTab === 'changes' && (
                  <ChangePane
                    token={token}
                    pid={pid}
                    sessionId={sessionId}
                    refreshSignal={fsSignal}
                    onReverted={() => {
                      // 回退动了盘上的文件，文件树与看板都得重新读
                      setFsSignal((n) => n + 1)
                      void loadFlow(true)
                    }}
                  />
                )}
                {buildTab === 'test' && (
                  <div className="pane-scroll">
                    <TestPane events={testEvents} />
                  </div>
                )}
                {buildTab === 'code' && (
                  <div className="pane-scroll">
                    <CodePane events={codeEvents} />
                  </div>
                )}
              </div>
            </div>
          )}

          {stage === 'verify' && (
            <CasePane
              token={token}
              rid={rid}
              cases={cases}
              loading={casesLoading}
              onReload={(silent) => Promise.all([loadCases(silent), loadFlow(true)]).then(() => undefined)}
              onAskAgent={
                busy || !requirement
                  ? undefined
                  : () => paneRef.current?.loadDraft(verifyCasesPrompt(requirement?.dir_name || ''))
              }
            />
          )}

          {stage === 'archive' && (
            <ArchivePane
              token={token}
              rid={rid}
              flow={flow}
              cases={cases}
              onReload={(silent) => Promise.all([loadFlow(!silent), loadCases(true)]).then(() => undefined)}
            />
          )}
        </section>

        {/* 需求澄清 / 用例配置 / 编码实现有对话；归档验收是纯操作页，左栏独占全宽 */}
        {(stage === 'clarify' || stage === 'verify' || stage === 'build') && (
          <section className="wb-right">
            <RequirementPane
              ref={paneRef}
              requirement={requirement}
              messages={conv}
              busy={busy}
              streamText={streamText}
              statusText={statusText}
              onSend={send}
              showBrief={stage !== 'clarify'}
              quickCommands={quickCommands}
              stepHint={stepHint}
              onHintAction={
                stepHint?.actionStage
                  ? () => void changeStage(stepHint.actionStage as Stage)
                  : undefined
              }
              onAbort={() => void abortRun()}
              aborting={aborting}
            />
          </section>
        )}
      </div>
    </div>
  )
}
