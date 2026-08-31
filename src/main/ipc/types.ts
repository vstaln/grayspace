import type { BrowserWindow } from 'electron'
import type { CoordinationStore } from '../coordination.ts'
import type { TerminalManager } from '../terminals.ts'
import type { CanvasStore } from '../canvasState.ts'
import type { CodeStore } from '../codeState.ts'
import type { PlannerStore } from '../plannerStore.ts'
import type { OrchestrationStore } from '../orchestration/store.ts'
import type { AppState, SettingsPatch } from '../appState.ts'
import type { Core } from '../core/index.ts'

/** Everything an IPC registrar may need. Registrars destructure what they use. */
export interface IpcDeps {
  core: Core
  terminals: TerminalManager
  coordination: CoordinationStore
  planner: PlannerStore
  /** Runs, delegated tasks, dispatches and the coordinator inbox. */
  orchestration: OrchestrationStore
  canvas: CanvasStore
  code: CodeStore
  state: AppState
  getWindow(): BrowserWindow | null
  getWorkspaceDir(): string | undefined
  setWorkspaceDir(dir: string | undefined): void
}

export type { SettingsPatch }
