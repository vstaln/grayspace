import type { BrainStore } from '../brain'
import type { CanvasStore } from '../canvasState'
import type { CoordinationStore } from '../coordination'
import type { TerminalManager } from '../terminals'
import type { Core } from '../core/index.ts'
import { registerBoardCommands } from './board.ts'
import { registerCanvasCommands } from './canvas.ts'
import { registerNoteCommands } from './notes.ts'
import { registerTerminalCommands } from './terminals.ts'

export interface CommandDeps {
  core: Core
  canvas: CanvasStore
  brain: BrainStore
  board: CoordinationStore
  terminals: TerminalManager
  /** Asks the renderer to mount a widget for an already-reserved terminal id. */
  requestWidget(info: { id: string; title: string }): void
  requestWidgetRemoval(id: string): void
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
export function registerCommands(deps: CommandDeps): void {
  registerCanvasCommands(deps)
  registerNoteCommands(deps)
  registerBoardCommands(deps)
  registerTerminalCommands(deps)
}

export const NEW = {
  note: 'note:new',
  task: 'task:new',
  terminal: 'terminal:new',
  widget: 'widget:new'
} as const
