import type { BrainStore } from '../brain'
import type { CanvasStore } from '../canvasState'
import type { CoordinationStore } from '../coordination'
import type { PlannerStore } from '../plannerStore.ts'
import type { TerminalManager } from '../terminals'
import type { TerminalSnapshots } from '../terminalSnapshots'
import type { Core } from '../core/index.ts'
import { registerBoardCommands } from './board.ts'
import { registerCanvasCommands } from './canvas.ts'
import { registerGitCommands } from './git.ts'
import { registerNoteCommands } from './notes.ts'
import { registerPlannerCommands } from './planner.ts'
import { registerTerminalCommands } from './terminals.ts'
import { registerBuiltinWidgets } from '../widgets/registry.ts'
import type { GitStatus } from '../git.ts'

export interface CommandDeps {
  core: Core
  canvas: CanvasStore
  brain: BrainStore
  board: CoordinationStore
  planner: PlannerStore
  terminals: TerminalManager
  /** Saved cwd/title/scrollback so a reopened terminal has its context back. */
  snapshots: TerminalSnapshots
  /**
   * Asks the renderer to mount a widget for an already-reserved terminal id.
   * `from` is the widget that caused it to open — the canvas draws the link.
   */
  requestWidget(info: { id: string; title: string; from?: string | null }): void
  requestWidgetRemoval(id: string): void
  /** Which terminal an agent is most likely running in, for the link above. */
  originWidgetId(): string | null
  /** Drops a closed terminal so it stops being offered as an origin. */
  forgetOrigin(id: string): void
  defaultCwd(): string | undefined
}

/**
 * Every write the app can perform, in one registry.
 *
 * A transport that wants to change something looks up nothing and calls no
 * store: it builds a command and submits it. Which means the list of things
 * that can happen to OrcSpace state is exactly the list of types registered
 * here — greppable, testable, and journaled without anyone remembering to.
 *
 * Two conventions worth knowing:
 *
 * - Creates target a `<scheme>:new` sentinel, because the id does not exist
 *   until the handler runs. The sentinel doubles as a serialisation point, so
 *   two actors creating notes at once queue behind each other rather than
 *   racing for the same generated id.
 * - Handlers throw {@link CommandError}; the bus turns that into a typed
 *   failure. They never send IPC, never touch HTTP, and never check who the
 *   caller is beyond what the bus already established.
 */
export function registerCommands(deps: CommandDeps): { git: { status(): Promise<GitStatus> } } {
  registerBuiltinWidgets()
  registerCanvasCommands(deps)
  registerNoteCommands(deps)
  registerBoardCommands(deps)
  registerPlannerCommands(deps)
  registerTerminalCommands(deps)
  return { git: registerGitCommands(deps) }
}

export const NEW = {
  note: 'note:new',
  task: 'task:new',
  terminal: 'terminal:new',
  widget: 'widget:new',
  plan: 'plan:new'
} as const
