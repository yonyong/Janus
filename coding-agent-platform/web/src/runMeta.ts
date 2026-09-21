/** 对话区展示的本轮 Agent 运行用量 / 耗时。 */

/** 单次合计 Token 达到该值时，气泡底部用量行红色警示。 */
export const TOKEN_WARN_THRESHOLD = 10_000_000

/** 本会话用户轮次达到该值时，提示新开会话以控制上下文膨胀。 */
export const SESSION_ROUND_HINT = 3

export interface RunMeta {
  elapsed_ms?: number | null
  prompt_tokens?: number | null
  completion_tokens?: number | null
  total_tokens?: number | null
}

export function fmtElapsed(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return ''
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return ''
  return n.toLocaleString('en-US')
}

/** 是否有可展示的用量 / 耗时（全空则不渲染页脚）。 */
export function hasRunMeta(m: RunMeta | null | undefined): boolean {
  if (!m) return false
  return (
    (m.elapsed_ms != null && m.elapsed_ms > 0) ||
    m.prompt_tokens != null ||
    m.completion_tokens != null ||
    m.total_tokens != null
  )
}

export function isTokenWarn(m: RunMeta | null | undefined): boolean {
  if (!m) return false
  const total =
    m.total_tokens != null
      ? m.total_tokens
      : (m.prompt_tokens || 0) + (m.completion_tokens || 0)
  return total >= TOKEN_WARN_THRESHOLD
}

/** 从 SSE done 事件拼出 RunMeta。 */
export function runMetaFromDone(d: {
  elapsed_ms?: number
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}): RunMeta {
  const u = d.usage || {}
  return {
    elapsed_ms: d.elapsed_ms ?? null,
    prompt_tokens: u.prompt_tokens ?? null,
    completion_tokens: u.completion_tokens ?? null,
    total_tokens: u.total_tokens ?? null,
  }
}
