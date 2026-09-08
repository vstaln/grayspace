import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FolderOpen, ImagePlus, Loader2, Paperclip, Play, Workflow } from 'lucide-react'
import type { SystemTerminalInfo } from '../../../preload/index.d'
import { useSettings } from '../hooks/useSettings'

interface Props { widgetId: string }

const AGENTS = [
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'antigravity', label: 'Antigravity', command: 'agy' },
  { id: 'grok', label: 'Grok', command: 'grok' }
] as const

type MissionState = 'idle' | 'starting' | 'running' | 'completed' | 'failed'
type ActiveMission = { planId: string; title: string; runId: string; taskId: string; terminalId: string }






export default function MissionWidget({ widgetId }: Props): React.JSX.Element {
  const { settings } = useSettings()
  const [terminals, setTerminals] = useState<SystemTerminalInfo[]>([])
  const [terminalId, setTerminalId] = useState('')
  const [agent, setAgent] = useState('opencode')
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  const [objective, setObjective] = useState('')
  const [references, setReferences] = useState<string[]>([])
  const [state, setState] = useState<MissionState>('idle')
  const [status, setStatus] = useState('Ready to start a mission.')
  const [activeMission, setActiveMission] = useState<ActiveMission | null>(null)
  const activeMissionRef = useRef<ActiveMission | null>(null)
  activeMissionRef.current = activeMission

  const refreshTerminals = async (): Promise<void> => {
    try {
      const stats = await window.api.system.stats()
      if (!('error' in stats)) setTerminals(stats.activeTerminals.filter((item) => item.id !== widgetId))
    } catch {  }
  }

  useEffect(() => {
    void refreshTerminals()
    const timer = window.setInterval(() => void refreshTerminals(), 1500)
    void window.api.workspace.getDir().then(setWorkspaceDir).catch(() => setWorkspaceDir(null))
    return () => window.clearInterval(timer)
  }, [widgetId])



  useEffect(() => {
    const refreshMission = async (): Promise<void> => {
      const mission = activeMissionRef.current
      if (!mission) return
      try {
        const snapshot = await window.api.orchestration.snapshot(mission.runId)
        const task = snapshot.tasks.find((item) => item.id === mission.taskId)
        if (!task) return
        if (task.status === 'completed') {
          await window.api.planner.toggle(mission.planId, true).catch(() => {})
          setState('completed')
          setStatus('Mission completed. Planner item checked off.')
          activeMissionRef.current = null
          setActiveMission(null)
        } else if (task.status === 'failed' || task.status === 'blocked') {
          setState('failed')
          setStatus(task.status === 'blocked' ? 'Mission is blocked; check OrcSpace for the pending question.' : 'Mission failed; check the worker report in OrcSpace.')
          if (task.status === 'failed') {
            activeMissionRef.current = null
            setActiveMission(null)
          }
        }
      } catch {  }
    }
    const off = window.api.orchestration.onChange(() => void refreshMission())
    void refreshMission()
    return off
  }, [])

  const selectedAgent = useMemo(() => AGENTS.find((item) => item.id === agent) ?? AGENTS[0], [agent])

  const attachReferences = (files: File[]): void => {
    const paths = files.map((file) => window.api.media.getPathForFile(file)).filter((path): path is string => Boolean(path))
    if (paths.length) setReferences((current) => Array.from(new Set([...current, ...paths])).slice(0, 12))
  }

  const startMission = async (): Promise<void> => {
    const text = objective.trim()
    if (!settings.missionMode || !text || activeMissionRef.current) return
    setState('starting')
    setStatus('Creating Planner item and starting the worker…')
    const title = `Mission · ${text.slice(0, 150)}`
    const today = new Intl.DateTimeFormat('en-CA').format(new Date())
    const referenceLines = references.length ? references.map((path) => `- ${path}`).join('\n') : '- none'
    const marker = `ORCSPACE_MISSION_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const spec = [
      'Goal: complete the user objective in the selected workspace.',
      `Objective: ${text}`,
      `Workspace: ${workspaceDir || 'current workspace'}`,
      `References:\n${referenceLines}`,
      'Scope: make only the changes required for this objective.',
      'Acceptance: verify the result with the relevant tests or checks.',
      'Verify: run the exact test/check command and report its result.',
      'Stop when: acceptance criteria are met or a blocker requires a human decision.',
      'Report completion exactly once with `orc done`.'
    ].join('\n')
    const plan = await window.api.planner.create({ title, project: 'Mission', day: today, note: `${marker}\n${spec}`, attachments: references })
    if ('error' in plan) {
      setState('failed')
      setStatus(`Could not create Planner item: ${plan.error}`)
      return
    }
    const result = await window.api.mission.start({ objective: text, title, spec, planId: plan.id, agent: selectedAgent.id, terminalId: terminalId || undefined })
    if ('error' in result) {
      await window.api.planner.delete(plan.id).catch(() => {})
      setState('failed')
      setStatus(`Could not start worker: ${result.error}`)
      return
    }
    const next: ActiveMission = { planId: plan.id, title, runId: result.runId, taskId: result.taskId, terminalId: result.terminalId }
    activeMissionRef.current = next
    setActiveMission(next)
    setState('running')
    setStatus(`${selectedAgent.label} is working through OrcSpace…`)



    window.dispatchEvent(new CustomEvent('orcspace:mission-plan', { detail: { planId: plan.id, title } }))
    window.dispatchEvent(new CustomEvent('orcspace:mission-start', { detail: { missionId: result.runId, planId: plan.id, title, terminalId: result.terminalId } }))
    window.dispatchEvent(new CustomEvent('orcspace:mission-worker', { detail: { planId: plan.id, terminalId: result.terminalId } }))
    setObjective('')
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden px-3 py-2 text-[11px]" data-testid="mission-widget" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); attachReferences(Array.from(event.dataTransfer.files)) }} onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) attachReferences(files) }}>
      <div className="flex items-center gap-2 rounded-[9px] border border-line-soft bg-bg-hover/30 px-2.5 py-2">
        <Workflow size={14} className="flex-none text-accent" />
        <div className="min-w-0 flex-1"><div className="truncate text-text">Mission Controller</div><div className="truncate text-[10px] text-text-faint">{status}</div></div>
        {!settings.missionMode && <span className="rounded-full border border-line px-1.5 py-0.5 text-[9px] text-text-faint">OFF</span>}
        {state === 'running' || state === 'starting' ? <Loader2 size={13} className="animate-spin text-accent" /> : state === 'completed' ? <Check size={14} className="text-text" /> : null}
      </div>
      <label className="flex flex-col gap-1 text-text-faint"><span>Worker terminal</span>
        <select value={terminalId} disabled={!settings.missionMode || state === 'running' || state === 'starting'} onChange={(event) => setTerminalId(event.target.value)} className="rounded-[7px] border border-line-soft bg-bg-raise px-2 py-1.5 text-text outline-none disabled:opacity-50">
          <option value="">Open a new terminal (recommended)</option>{terminals.map((item) => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-text-faint"><span>Coding agent</span>
        <select value={agent} onChange={(event) => setAgent(event.target.value)} disabled={state === 'running' || state === 'starting'} className="rounded-[7px] border border-line-soft bg-bg-raise px-2 py-1.5 text-text outline-none">{AGENTS.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.command}</option>)}</select>
      </label>
      <div className="flex items-center gap-1.5 rounded-[7px] border border-line-soft bg-bg-hover/20 px-2 py-1.5 text-[10px] text-text-faint"><FolderOpen size={12} className="flex-none" /><span className="min-w-0 flex-1 truncate" title={workspaceDir ?? undefined}>{workspaceDir || 'No workspace directory selected'}</span></div>
      <textarea value={objective} onChange={(event) => setObjective(event.target.value)} disabled={!settings.missionMode || state === 'running' || state === 'starting'} placeholder="Describe the mission…" className="min-h-[92px] flex-1 resize-none rounded-[8px] border border-line-soft bg-transparent px-2.5 py-2 text-text outline-none placeholder:text-text-faint focus:border-line" />
      {references.length > 0 && <div className="max-h-14 overflow-auto rounded-[7px] border border-line-soft px-2 py-1 text-[10px] text-text-faint">{references.map((path) => <div key={path} className="truncate">{path}</div>)}</div>}
      <div className="flex items-center justify-between gap-2"><label className="flex cursor-pointer items-center gap-1.5 rounded-[7px] border border-line-soft px-2 py-1.5 text-text-dim hover:bg-bg-hover"><ImagePlus size={12} /><span>Reference</span><input type="file" accept="image/*" multiple className="hidden" onChange={(event) => { attachReferences(Array.from(event.target.files ?? [])); event.target.value = '' }} /></label><button type="button" onClick={() => void startMission()} disabled={!settings.missionMode || !objective.trim() || !!activeMission || state === 'running' || state === 'starting'} className="flex items-center gap-1.5 rounded-[7px] bg-accent px-3 py-1.5 font-medium text-bg disabled:opacity-40"><Play size={12} />Start mission</button></div>
      <div className="flex items-center gap-1 text-[10px] text-text-faint"><Paperclip size={10} /> Drop or paste references; they are attached to the Planner item.</div>
    </div>
  )
}
