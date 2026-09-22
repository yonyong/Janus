import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { App as AntdApp, Empty, Spin } from 'antd'
import { useToken, useAuth } from '../auth'
import {
  Requirement,
  TestCase,
  WorkflowState,
  listCases,
  listProjects,
  requirementWorkflow,
  sessionDetail,
  type Project,
} from '../api'
import type { AuxTab } from '../components/FileWorkArea'
import { AuxScreenFrame } from '../components/AuxScreenDock'
import {
  auxLabel,
  loadAuxSnapshot,
  saveAuxSnapshot,
} from '../components/auxScreen'
import ProjectSettingsModal from '../components/ProjectSettingsModal'

/**
 * 副屏弹出页：左右各一个业务 tab，不含 Agent 对话。
 * 路由：/#/workbench/:sid/aux/:auxId?pid=&rid=&left=&right=
 */
export default function AuxScreenPage() {
  const { sid, auxId } = useParams()
  const sessionId = Number(sid)
  const [params] = useSearchParams()
  const token = useToken()
  const { isAdmin } = useAuth()
  const { message } = AntdApp.useApp()

  const snap = auxId ? loadAuxSnapshot(auxId) : null
  const [left, setLeft] = useState<AuxTab>((params.get('left') as AuxTab) || snap?.left || 'code')
  const [right, setRight] = useState<AuxTab>((params.get('right') as AuxTab) || snap?.right || 'logs')
  const [requirement, setRequirement] = useState<Requirement | null>(null)
  const [flow, setFlow] = useState<WorkflowState | null>(null)
  const [cases, setCases] = useState<TestCase[]>([])
  const [casesLoading, setCasesLoading] = useState(false)
  const [diskPath, setDiskPath] = useState<string | undefined>()
  const [pid, setPid] = useState<number | null>(
    Number(params.get('pid') || snap?.pid || 0) || null,
  )
  const [project, setProject] = useState<Project | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [fsSignal, setFsSignal] = useState(0)

  const rid = requirement?.id ?? (params.get('rid') ? Number(params.get('rid')) : snap?.rid ?? null)

  useEffect(() => {
    if (!auxId || !Number.isFinite(sessionId)) return
    saveAuxSnapshot(
      { id: auxId, left, right, mode: 'popup' },
      { sid: sessionId, pid: pid || 0, rid },
    )
  }, [auxId, left, right, sessionId, pid, rid])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const info = await sessionDetail(token, sessionId)
        if (!alive) return
        setDiskPath(info.disk_path || undefined)
        setPid(info.project_id ?? pid)
        if (info.requirement) setRequirement(info.requirement)
        if (info.requirement?.id) {
          try {
            setFlow(await requirementWorkflow(token, info.requirement.id))
          } catch {
            /* optional */
          }
        }
        const projId = info.project_id ?? pid
        if (projId) {
          const ps = await listProjects(token)
          const p = ps.find((x) => x.id === projId) || null
          if (alive) setProject(p)
          if (alive && p?.disk_path) setDiskPath(p.disk_path)
        }
      } catch (e: any) {
        if (alive) message.error(String(e.message || e))
      } finally {
        if (alive) setReady(true)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token])

  const loadCases = useCallback(
    async (silent?: boolean) => {
      if (!rid) return
      if (!silent) setCasesLoading(true)
      try {
        setCases(await listCases(token, rid))
      } catch (e: any) {
        if (!silent) message.error(String(e.message || e))
      } finally {
        if (!silent) setCasesLoading(false)
      }
    },
    [rid, token, message],
  )

  useEffect(() => {
    void loadCases(true)
  }, [loadCases])

  if (!Number.isFinite(sessionId) || !auxId) {
    return <Empty description="无效的副屏地址" />
  }

  if (!ready) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin tip="加载副屏…" />
      </div>
    )
  }

  const ctx = {
    token,
    pid,
    rid,
    requirement,
    flow,
    cases,
    casesLoading,
    diskPath,
    sessionId,
    refreshSignal: fsSignal,
    busy: false,
    onDocSaved: (r: Requirement) => setRequirement(r),
    onReloadCases: async (silent?: boolean) => {
      await loadCases(!!silent)
      if (rid) {
        try {
          setFlow(await requirementWorkflow(token, rid))
        } catch {
          /* ignore */
        }
      }
    },
    onReverted: () => setFsSignal((n) => n + 1),
    onUseCommand: () => {
      message.info('副屏不含对话，请回到主工作台发送指令')
    },
    isAdmin,
    onOpenProjectSettings: isAdmin && project ? () => setSettingsOpen(true) : undefined,
  }

  return (
    <>
      <AuxScreenFrame
        left={left}
        right={right}
        onLeft={setLeft}
        onRight={setRight}
        title={auxLabel({ left, right })}
        ctx={ctx}
      />
      <ProjectSettingsModal
        open={settingsOpen}
        project={project}
        token={token}
        onCancel={() => setSettingsOpen(false)}
        onSaved={(p) => {
          message.success('项目设置已保存')
          setProject(p)
          setSettingsOpen(false)
          setFsSignal((n) => n + 1)
        }}
      />
    </>
  )
}
