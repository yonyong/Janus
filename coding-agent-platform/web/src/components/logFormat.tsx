/** 磁盘日志行格式渲染：级别着色 + 时间戳弱高亮（不做 ANSI / JSON pretty）。 */

import type { ReactNode } from 'react'

const LEVEL_RE = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL|TRACE)\b/i
const TIME_RE =
  /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/

export type LogLevelTone = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'other'

export function detectLevel(line: string): LogLevelTone {
  const m = line.match(LEVEL_RE)
  if (!m) return 'other'
  const k = m[1].toUpperCase()
  if (k === 'DEBUG' || k === 'TRACE') return 'debug'
  if (k === 'INFO') return 'info'
  if (k === 'WARN' || k === 'WARNING') return 'warn'
  if (k === 'ERROR') return 'error'
  if (k === 'FATAL' || k === 'CRITICAL') return 'fatal'
  return 'other'
}

const LEVEL_CLASS: Record<LogLevelTone, string> = {
  debug: 'disk-log-lv-debug',
  info: 'disk-log-lv-info',
  warn: 'disk-log-lv-warn',
  error: 'disk-log-lv-error',
  fatal: 'disk-log-lv-fatal',
  other: 'disk-log-lv-other',
}

/** 把一行拆成 React 可渲染的片段（时间戳 span + 级别 span + 其余文本）。 */
export function formatLogLine(line: string): { tone: LogLevelTone; nodes: ReactNode[] } {
  const tone = detectLevel(line)
  const nodes: ReactNode[] = []
  let rest = line
  let key = 0

  const pushText = (t: string, cls?: string) => {
    if (!t) return
    nodes.push(
      cls ? (
        <span key={key++} className={cls}>
          {t}
        </span>
      ) : (
        <span key={key++}>{t}</span>
      ),
    )
  }

  // 时间戳
  const tm = rest.match(TIME_RE)
  if (tm && tm.index != null) {
    pushText(rest.slice(0, tm.index))
    pushText(tm[0], 'disk-log-time')
    rest = rest.slice(tm.index + tm[0].length)
  }

  // 级别
  const lm = rest.match(LEVEL_RE)
  if (lm && lm.index != null) {
    pushText(rest.slice(0, lm.index))
    pushText(lm[0], `disk-log-level ${LEVEL_CLASS[tone]}`)
    rest = rest.slice(lm.index + lm[0].length)
  }

  pushText(rest)
  return { tone, nodes }
}
