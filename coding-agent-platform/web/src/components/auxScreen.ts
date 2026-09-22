/** 副屏实例类型与 sessionStorage 辅助。 */

import type { AuxTab } from './FileWorkArea'

export type AuxMode = 'docked' | 'popup'

export interface AuxScreenInstance {
  id: string
  left: AuxTab
  right: AuxTab
  mode: AuxMode
  minimized?: boolean
  label?: string
}

const STORAGE_PREFIX = 'janus.aux.'

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

export function auxLabel(inst: { left: string; right: string }, index?: number): string {
  const map: Record<string, string> = {
    req: '需求',
    code: 'Files',
    script: '脚本',
    logs: '日志',
    cases: '用例',
    arch: '归档',
  }
  const body = `${map[inst.left] || inst.left} | ${map[inst.right] || inst.right}`
  return index != null ? `副屏${index + 1} · ${body}` : body
}

export function buildAuxPopupUrl(sid: number, auxId: string, q: {
  pid: number
  rid?: number | null
  left: AuxTab
  right: AuxTab
}): string {
  const u = new URL(window.location.href)
  u.hash = `#/workbench/${sid}/aux/${auxId}`
  // hash router: put query after hash path
  const params = new URLSearchParams()
  params.set('pid', String(q.pid))
  if (q.rid != null) params.set('rid', String(q.rid))
  params.set('left', q.left)
  params.set('right', q.right)
  return `${u.origin}${u.pathname}${u.search}#/workbench/${sid}/aux/${auxId}?${params.toString()}`
}
