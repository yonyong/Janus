import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { App as AntdApp, Button, Dropdown, Space, Tag, Typography } from 'antd'
import {
  ArrowLeftOutlined,
  DownOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PauseCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { useToken } from '../auth'
import {
  Message,
  Requirement,
  SessionDetail,
  Stage,
  STAGE_LABELS,
  TestCase,
  WorkflowState,
  Agent,
  abortSessionRun,
  createSession,
  describeError,
  importCasesFromWorkspace,
  listAgents,
  listCases,
  listRequirements,
  requirementWorkflow,
  sessionActiveRun,
  sessionDetail,
  sessionMessages,
  setRequirementStage,
  setSessionAgent,
  streamEvents,
} from '../api'
import type { RequirementPaneHandle } from '../components/RequirementPane'
import ThemeSwitcher from '../components/ThemeSwitcher'
import { buildFlowCommands, verifyCasesPrompt } from '../components/FlowCommands'
import FileWorkArea, { STAGE_CAT } from '../components/FileWorkArea'
import type { Cat } from '../components/FileWorkArea'
import RequirementPane from '../components/RequirementPane'

/**
 * 沉浸式工作台（2026-09 重设计版）：
 * - 顶部一条栏：返回 / 标题 / 会话·项目·Agent 元信息 / 当前阶段 chip / 运行状态。
 *   旧的工作流步骤条与标准/轻量模式切换已移除，阶段感知由右侧「流程指令」清单承载。
 * - 左栏固定文件区（FileWorkArea）：竖向分类（需求 / Files / 脚本 / 用例 / 归档 / 帮助）+
 *   分类内横向子页签，按 .janus/{dir}/ 存储规范映射；分栏支持拖拽调宽与收起。
 * - 右栏：流程指令清单（跨阶段连续编号、已完成打标）+ Agent 对话。
 *   归档验收不再是独立页面，汇总与验收操作在「归档」分类里完成。
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
  // 左栏分类（受控）：阶段变化时联动默认分类，快捷键 Alt+1~6 也能直接切换
  const [cat, setCat] = useState<Cat>('req')
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
  // 对话面板：多 Agent 时可选；列表按调度优先级排序
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentSwitching, setAgentSwitching] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  // 用户是否手动点过工作流节点：点过之后，迟到的加载结果不得把阶段覆盖回去
  const stagePicked = useRef(false)
  /** 右侧对话窗格：流程指令都只灌入输入框，由用户手动发送。 */
  const paneRef = useRef<RequirementPaneHandle | null>(null)

  // 左栏宽度（px）：null = 跟随默认 42%；支持拖拽调宽与一键收起
  const [leftPx, setLeftPx] = useState<number | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const draggingRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

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

  // 对话面板 Agent 选择：拉全量列表（含可用状态），多于 1 个时展示下拉
  useEffect(() => {
    let active = true
    listAgents()
      .then((as) => {
        if (active) setAgents(as)
      })
      .catch(() => {
        if (active) setAgents([])
      })
    return () => {
      active = false
    }
  }, [])

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

  // 阶段变化时联动左栏默认分类（点流程/切阶段时左栏跟着走；手动切分类不回写阶段）
  useEffect(() => {
    setCat(STAGE_CAT[stage])
  }, [stage])

  // ---------------- 步骤引导 ----------------

  // 一次运行结束后的下一步引导（纯提示，操作入口统一在流程指令清单的高亮上）
  const [stepHint, setStepHint] = useState<{ text: string } | null>(null)

  const stepHintAfterDone = useCallback((stageAtSend: Stage, label: string) => {
    if (stageAtSend === 'clarify') {
      if (label === '润色需求文档') {
        setStepHint({ text: '需求文档已润色完成，接下来建议执行「生成详细设计」' })
      } else if (label === '生成详细设计') {
        setStepHint({ text: '详细设计已生成，接下来建议配置测试用例「生成单测用例」' })
      }
    } else if (stageAtSend === 'verify') {
      if (label === '生成单测用例') {
        setStepHint({ text: '用例草稿已生成并自动导入，确认用例后可开始「按设计文档实现需求」' })
      }
    } else if (stageAtSend === 'build') {
      if (label === '按设计文档实现需求') {
        setStepHint({ text: '实现完成，建议执行「执行配置的单测」验证结果' })
      } else if (label === '执行配置的单测') {
        setStepHint({ text: '测试执行完毕，可在「归档」分类查看测试报告并给出验收结论' })
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
    const label =
      buildFlowCommands(requirement?.dir_name || '').find((c) => c.text === text)?.label || ''
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

  /** 切换本会话使用的 Agent；换 Agent 会清空 CLI 续聊上下文。 */
  const changeAgent = async (agentId: number) => {
    if (busy || agentSwitching) return
    if (info?.agent?.id === agentId) return
    setAgentSwitching(true)
    try {
      const r = await setSessionAgent(token, sessionId, agentId)
      setInfo((prev) => (prev ? { ...prev, agent: r.agent, agent_id: r.agent_id } : prev))
      message.success(r.agent ? `已切换到 ${r.agent.name}` : '已切换 Agent')
    } catch (e) {
      const i = describeError(e)
      message.error(`${i.title}${i.detail ? '：' + i.detail : ''}`)
    } finally {
      setAgentSwitching(false)
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, sessionId])

  const onPickSession = ({ key }: { key: string }) => {
    if (key === 'new') {
      void createNewSession()
      return
    }
    const target = Number(key.replace(/^s-/, ''))
    if (Number.isFinite(target)) gotoSession(target)
  }

  // 常用指令：供对话输入框上方常驻展示，点选填入输入框（item 13）。
  // 归档指令 text 为空（只切阶段），这里过滤掉，只留可发送的话术。
  const composerCommands = useMemo(
    () =>
      buildFlowCommands(requirement?.dir_name || '')
        .filter((c) => c.text)
        .map((c) => ({ label: c.label, desc: c.desc, text: c.text })),
    [requirement?.dir_name],
  )

  /** 帮助面板 / 输入框常用指令点选：切到对应阶段上下文 + 把话术灌入输入框。 */
  const onUseCommand = (text: string) => {
    if (busy || !text) return
    setStepHint(null)
    const cmd = buildFlowCommands(requirement?.dir_name || '').find((c) => c.text === text)
    if (cmd && cmd.stage !== stage) void changeStage(cmd.stage)
    paneRef.current?.loadDraft(text)
  }

  const title = requirement?.title || info?.requirement?.title || `会话 #${sid}`

  // ---------------- 分栏拖拽 ----------------

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !bodyRef.current) return
      const rect = bodyRef.current.getBoundingClientRect()
      const min = 320
      const max = Math.round(rect.width * 0.62)
      setLeftPx(Math.min(Math.max(e.clientX - rect.left - 10, min), max))
    }
    const onUp = () => {
      draggingRef.current = false
      document.body.classList.remove('wb-dragging')
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // ---------------- 快捷键（item 7 / 11：统一走 Alt 组合，避开浏览器占用） ----------------
  // 用 ref 持有最新回调，effect 只注册一次，避免闭包捕获旧状态。
  const hotkeyRef = useRef<() => (e: KeyboardEvent) => void>(() => () => {})
  hotkeyRef.current = () => (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return
    const actions: Record<string, () => void> = {
      '1': () => setCat('req'),
      '2': () => setCat('code'),
      '3': () => setCat('script'),
      '4': () => setCat('cases'),
      '5': () => setCat('arch'),
      '6': () => setCat('help'),
      b: () => {
        setLeftCollapsed((v) => !v)
        setLeftPx(null)
      },
      n: () => void createNewSession(),
      i: () => paneRef.current?.focus(),
      '.': () => {
        if (busy) void abortRun()
      },
    }
    const fn = actions[e.key.toLowerCase()]
    if (fn) {
      e.preventDefault()
      fn()
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => hotkeyRef.current()(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

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
            <Tag
              className="wb-stage-chip"
              style={{ marginInlineEnd: 0, borderRadius: 999, paddingInline: 10 }}
              title="当前阶段（由流程指令驱动推进）"
            >
              阶段：{STAGE_LABELS[stage]}
            </Tag>
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
          <ThemeSwitcher />
        </Space>
      </div>

      <div className={`wb-body${leftCollapsed ? ' wb-left-collapsed' : ''}`} ref={bodyRef}>
        <section className="wb-left" style={leftCollapsed ? undefined : { width: leftPx ?? undefined }}>
          <button
            type="button"
            className="wb-collapse-btn"
            title={leftCollapsed ? '展开左栏' : '收起左栏'}
            onClick={() => {
              setLeftCollapsed(!leftCollapsed)
              setLeftPx(null)
            }}
          >
            {leftCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
          <div
            className="wb-split"
            title="拖拽调整左右宽度 · 双击恢复默认"
            onMouseDown={(e) => {
              if (leftCollapsed) return
              draggingRef.current = true
              document.body.classList.add('wb-dragging')
              e.preventDefault()
            }}
            onDoubleClick={() => setLeftPx(null)}
          >
            <span className="wb-split-grip" />
          </div>
          <FileWorkArea
            token={token}
            pid={pid}
            rid={rid}
            cat={cat}
            onCatChange={setCat}
            requirement={requirement}
            flow={flow}
            cases={cases}
            casesLoading={casesLoading}
            diskPath={info?.disk_path ?? undefined}
            sessionId={sessionId}
            refreshSignal={fsSignal}
            busy={busy}
            onUseCommand={onUseCommand}
            onDocSaved={(r) => {
              setRequirement(r)
              void loadFlow(true)
            }}
            onReloadCases={async (silent) => {
              await loadCases(!!silent)
              await loadFlow(true)
            }}
            onReverted={() => {
              // 回退动了盘上的文件，文件树与看板都得重新读
              setFsSignal((n) => n + 1)
              void loadFlow(true)
            }}
            onAskAgent={
              busy || !requirement
                ? undefined
                : () => paneRef.current?.loadDraft(verifyCasesPrompt(requirement?.dir_name || ''))
            }
          />
        </section>

        <section className="wb-right">
          <RequirementPane
            ref={paneRef}
            messages={conv}
            busy={busy}
            streamText={streamText}
            statusText={statusText}
            onSend={send}
            sid={sessionId}
            pid={pid}
            token={token}
            quickCommands={composerCommands}
            stepHint={stepHint}
            onAbort={() => void abortRun()}
            aborting={aborting}
            agents={agents}
            agentId={info?.agent?.id ?? null}
            onChangeAgent={(id) => void changeAgent(id)}
            agentSwitching={agentSwitching}
          />
        </section>
      </div>
    </div>
  )
}
