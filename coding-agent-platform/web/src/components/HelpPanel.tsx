import { useState } from 'react'
import {
  BookOutlined,
  BulbOutlined,
  QuestionCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { buildFlowCommands } from './FlowCommands'
import { SHORTCUT_GROUPS } from '../shortcuts'

/** 帮助面板：替代旧「流程指令」区（不再展示阶段状态 / 推进进度，item 6）。
 *  横向 tab：入门指引 / 常用指令 / 快捷键 / 常见问题（item 10）。
 *  「常用指令」点选后把话术填入对话输入框（onUse），由用户手动发送。 */
type HelpTab = 'guide' | 'commands' | 'shortcuts' | 'faq'

const TABS: { key: HelpTab; label: string; icon: React.ReactNode }[] = [
  { key: 'guide', label: '入门指引', icon: <BookOutlined /> },
  { key: 'commands', label: '常用指令', icon: <ThunderboltOutlined /> },
  { key: 'shortcuts', label: '快捷键', icon: <BulbOutlined /> },
  { key: 'faq', label: '常见问题', icon: <QuestionCircleOutlined /> },
]

const STAGE_LABEL: Record<string, string> = {
  clarify: '需求澄清',
  verify: '用例配置',
  build: '编码实现',
  archive: '归档验收',
}

const GUIDE_STEPS = [
  {
    t: '需求澄清',
    d: '在「需求」里完善原始需求，让 Agent 润色并生成详细设计文档，作为后续编码依据。',
  },
  { t: '用例配置', d: '让 Agent 生成功能验证用例草稿，平台自动导入到「用例」列表，可批量管理。' },
  { t: '编码实现', d: 'Agent 按详细设计实现需求；每次运行前后自动快照比对，改动落库、可逐条回退。' },
  { t: '归档验收', d: '查看测试报告与用例状态，给出通过 / 打回结论并归档留痕。' },
]

const FAQ = [
  {
    q: 'Agent 运行中断了怎么办？',
    a: '被中止或断线的消息可以重发；同一条消息在一次运行中最多执行一次，重连会回放已产生的内容，不会重复改动工作区。',
  },
  {
    q: '改动记录能回退吗？',
    a: '可以。在「Files → 改动」里可回退单个文件或整条记录；回退本身也会记一条记录，随时可再回退。二进制与超大文件只记指纹、不可回退。',
  },
  {
    q: '常用指令里的路径为什么是 .janus/ 开头？',
    a: '平台按 .janus/{需求目录}/ 组织需求文档、用例、通用脚本与测试报告；指令话术里已写好固定路径，Agent 无需自己猜测。',
  },
  {
    q: '「脚本」和用例里的验收脚本有什么区别？',
    a: '「脚本」Tab 管理 .janus/{dir}/script/ 下的通用可参数化脚本；用例面板的总验收脚本仍是 usecase/accept.*，专用于验收回写用例状态。平台采集 stdout/stderr（UTF-8）；脚本勿自行改编码，可选落盘只写 JANUS_SCRIPT_LOG。',
  },
  {
    q: '新建会话会发生什么？',
    a: '会为当前需求切一个新的工作分支（git 仓库时），与历史会话隔离；可在顶部「会话 #N」下拉里随时切换。',
  },
]

function KeyCap({ text }: { text: string }) {
  return <kbd className="help-kbd">{text}</kbd>
}

export default function HelpPanel({
  dir,
  busy,
  onUse,
}: {
  dir: string
  busy?: boolean
  /** 点选常用指令：把话术填入对话输入框（不自动发送）。 */
  onUse: (text: string) => void
}) {
  const [tab, setTab] = useState<HelpTab>('guide')
  const cmds = buildFlowCommands(dir).filter((c) => c.text)

  return (
    <div className="help-pane">
      <div className="help-tabbar">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`help-tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span className="help-tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="help-body">
        {tab === 'guide' && (
          <div className="help-section">
            <p className="help-lead">
              沉浸式工作台按「需求澄清 → 用例配置 → 编码实现 → 归档验收」四个阶段推进。
              左栏切换需求 / Files / 脚本 / 用例 / 归档 / 帮助，右栏始终是与编码 Agent 的对话。
            </p>
            <ol className="help-steps">
              {GUIDE_STEPS.map((s, i) => (
                <li key={s.t}>
                  <span className="help-step-no">{i + 1}</span>
                  <span className="help-step-text">
                    <b>{s.t}</b>
                    <span>{s.d}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {tab === 'commands' && (
          <div className="help-section">
            <p className="help-lead">点选指令即填入对话输入框，确认无误后手动发送。</p>
            <div className="help-cmds">
              {cmds.map((c, i) => (
                <button
                  key={c.label}
                  type="button"
                  className="help-cmd"
                  disabled={busy}
                  title={c.text}
                  onClick={() => onUse(c.text)}
                >
                  <span className="help-cmd-top">
                    <span className="help-cmd-num">{i + 1}</span>
                    <span className="help-cmd-name">{c.label}</span>
                    <span className="help-cmd-stage">{STAGE_LABEL[c.stage] || c.stage}</span>
                  </span>
                  <span className="help-cmd-desc">{c.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'shortcuts' && (
          <div className="help-section">
            <p className="help-lead">
              触发类快捷键统一使用 <b>Alt</b> 组合，避免与浏览器快捷键冲突。
            </p>
            {SHORTCUT_GROUPS.map((g) => (
              <div key={g.group} className="help-sc-group">
                <div className="help-sc-title">{g.group}</div>
                {g.items.map((it) => (
                  <div key={it.desc} className="help-sc-row">
                    <span className="help-sc-keys">
                      {it.keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && <span className="help-sc-plus">+</span>}
                          <KeyCap text={k} />
                        </span>
                      ))}
                    </span>
                    <span className="help-sc-desc">{it.desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {tab === 'faq' && (
          <div className="help-section">
            <div className="help-faq">
              {FAQ.map((f) => (
                <div key={f.q} className="help-faq-item">
                  <div className="help-faq-q">
                    <QuestionCircleOutlined /> {f.q}
                  </div>
                  <div className="help-faq-a">{f.a}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
