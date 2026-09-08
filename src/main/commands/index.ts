import type { CanvasStore } from '../canvasState.ts'
import type { PlannerStore } from '../plannerStore.ts'
import type { OrchestrationStore } from '../orchestration/store.ts'
import type { TerminalManager } from '../terminals.ts'
import type { TerminalSnapshots } from '../terminalSnapshots.ts'
import type { Core } from '../core/index.ts'
import { registerCanvasCommands } from './canvas.ts'
import { registerFileCommands } from './files.ts'
import { registerGitCommands } from './git.ts'
import { registerOrchestrationCommands } from './orchestration.ts'
import { registerPlannerCommands } from './planner.ts'
import { registerTerminalCommands } from './terminals.ts'
import { registerBuiltinWidgets } from '../widgets/registry.ts'
import type { GitStatus } from '../git.ts'

export interface CommandDeps {
  core: Core
  canvas: CanvasStore
  planner: PlannerStore

  orchestration: OrchestrationStore
  terminals: TerminalManager

  snapshots: TerminalSnapshots




  requestWidget(info: { id: string; title: string; kind?: string; x?: number; y?: number; from?: string | null }): void
  requestWidgetRemoval(id: string): void
  requestWidgetRename?(id: string, title: string): void

  originWidgetId(): string | null

  forgetOrigin(id: string): void
  defaultCwd(): string | undefined
}



















export function registerCommands(deps: CommandDeps): { git: { status(): Promise<GitStatus> } } {
  registerBuiltinWidgets()
  registerCanvasCommands(deps)
  registerPlannerCommands(deps)
  registerOrchestrationCommands(deps)
  registerTerminalCommands(deps)
  registerFileCommands(deps)
  return { git: registerGitCommands(deps) }
}

export const NEW = {
  terminal: 'terminal:new',
  widget: 'widget:new',
  plan: 'plan:new',
  run: 'run:new',
  orctask: 'orctask:new',
  dispatch: 'dispatch:new',
  gate: 'gate:new'
} as const
