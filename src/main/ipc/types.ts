import type { BrowserWindow } from 'electron'
import type { TerminalManager } from '../terminals.ts'
import type { CanvasStore } from '../canvasState.ts'
import type { CodeStore } from '../codeState.ts'
import type { PlannerStore } from '../plannerStore.ts'
import type { OrchestrationStore } from '../orchestration/store.ts'
import type { AppState, SettingsPatch } from '../appState.ts'
import type { Core } from '../core/index.ts'


export interface IpcDeps {
  core: Core
  terminals: TerminalManager
  planner: PlannerStore

  orchestration: OrchestrationStore
  canvas: CanvasStore
  code: CodeStore
  state: AppState
  getWindow(): BrowserWindow | null
  getWorkspaceDir(): string | undefined
  setWorkspaceDir(dir: string | undefined): void
}

export type { SettingsPatch }
