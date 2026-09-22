/** 副屏实例类型与 sessionStorage 辅助。 */

import type { AuxTab } from './FileWorkArea'

export type AuxMode = 'docked' | 'popup'

/** left / right 至少填一个；只填一个时副屏为全屏单栏。 */
export interface AuxScreenInstance {
  id: string
  left: AuxTab | null
  right: AuxTab | null
  mode: AuxMode
  minimized?: boolean
  label?: string
}

const STORAGE_PREFIX = 'janus.aux.'

const TAB_LABEL: Record<string, string> = {
  req: '需求',
  code: 'Files',
  script: '脚本',
  logs: '日志',
  cases: '用例',
  arch: '归档',
}

export function newAuxId(): string {
  return `aux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function saveAuxSnapshot(inst: AuxScreenInstance, ctx: { sid: number; pid: number; rid: number | null }) {
  try {
    sessionStorage.setItem(
      STORAGE_PREFIX + inst.id,
      JSON.stringify({ ...inst, sid: ctx.sid, pid: ctx.pid, rid: ctx.rid }),
    )
  } catch {
    /* ignore quota */
  }
}

export function loadAuxSnapshot(auxId: string): (AuxScreenInstance & { sid?: number; pid?: number; rid?: number | null }) | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + auxId)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function auxLabel(
  inst: { left?: AuxTab | string | null; right?: AuxTab | string | null },
  index?: number,
): string {
  const parts = [inst.left, inst.right]
    .filter((t): t is string => !!t)
    .map((t) => TAB_LABEL[t] || t)
  const body = parts.length ? parts.join(' | ') : '空'
  return index != null ? `副屏${index + 1} · ${body}` : body
}

export function buildAuxPopupUrl(sid: number, auxId: string, q: {
  pid: number
  rid?: number | null
  left: AuxTab | null
  right: AuxTab | null
}): string {
  const params = new URLSearchParams()
  params.set('pid', String(q.pid))
  if (q.rid != null) params.set('rid', String(q.rid))
  if (q.left) params.set('left', q.left)
  if (q.right) params.set('right', q.right)
  return `${window.location.origin}${window.location.pathname}${window.location.search}#/workbench/${sid}/aux/${auxId}?${params.toString()}`
}
