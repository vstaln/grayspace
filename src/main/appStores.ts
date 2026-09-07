import { app } from 'electron'
import { join as joinPath } from 'path'
import { AppState } from './appState.ts'
import { CanvasStore } from './canvasState.ts'
import { CodeStore } from './codeState.ts'
import { PlannerStore } from './plannerStore.ts'
import { CoordinationStore } from './coordination.ts'
import { OrchestrationStore } from './orchestration/store.ts'
import { TerminalManager } from './terminals.ts'
import { TerminalStreamBatcher } from './terminalBatcher.ts'
import { TerminalSnapshots } from './terminalSnapshots.ts'
import { createCore } from './core/index.ts'
import { FileJournalSink, readJournalTail } from './journalSink.ts'
import { initPlannerSync } from './plannerSync.ts'
import type { Core } from './core/index.ts'

export interface AppStores {
  core: Core
  state: AppState
  terminals: TerminalManager
  terminalBatcher: TerminalStreamBatcher
  snapshots: TerminalSnapshots
  coordination: CoordinationStore
  canvas: CanvasStore
  code: CodeStore
  planner: PlannerStore
  orchestration: OrchestrationStore
  disposePlannerSync: () => void
  journalFile: string
}

export function createAppStores(): AppStores {
  const journalFile = joinPath(app.getPath('userData'), 'command-journal.ndjson')
  const journalTail = readJournalTail(journalFile)
  const core = createCore({
    sink: new FileJournalSink({ file: journalFile }),
    startSeq: journalTail.lastSeq,
    seed: journalTail.entries
  })

  const state = new AppState()
  const terminals = new TerminalManager({ getWindowsShell: () => state.settings.windowsShell })
  const terminalBatcher = new TerminalStreamBatcher()
  const snapshots = new TerminalSnapshots()
  const coordination = new CoordinationStore(core.locks, (id) => core.actors.isAlive(id))
  const canvas = new CanvasStore()
  const code = new CodeStore()
  const initialCodeWorkspace = state.codeWorkspaceState()
  code.setWorkspaceScope(
    state.activeCodeWorkspaceScope(),
    initialCodeWorkspace.activeId === initialCodeWorkspace.workspaces[0]?.id ? state.workspaceDir : undefined
  )
  const planner = new PlannerStore()
  const orchestration = new OrchestrationStore()
  const disposePlannerSync = initPlannerSync(planner, coordination)

  return {
    core,
    state,
    terminals,
    terminalBatcher,
    snapshots,
    coordination,
    canvas,
    code,
    planner,
    orchestration,
    disposePlannerSync,
    journalFile
  }
}
