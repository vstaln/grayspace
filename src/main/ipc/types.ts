import type { BrowserWindow } from 'electron'
import type { CoordinationStore } from '../coordination.ts'
import type { TerminalManager } from '../terminals.ts'
import type { BrainStore } from '../brain.ts'
import type { CanvasStore } from '../canvasState.ts'
import type { PlannerStore } from '../plannerStore.ts'
import type { AppState, SettingsPatch } from '../appState.ts'
import type { Core } from '../core/index.ts'
import type { TelegramBot } from '../telegramBot.ts'

/** Everything an IPC registrar may need. Registrars destructure what they use. */
export interface IpcDeps {
  core: Core
  telegram?: TelegramBot
  terminals: TerminalManager
  coordination: CoordinationStore
  planner: PlannerStore
  brain: BrainStore
  canvas: CanvasStore
  state: AppState
  getWindow(): BrowserWindow | null
  getWorkspaceDir(): string | undefined
  setWorkspaceDir(dir: string | undefined): void
}

export type { SettingsPatch }
