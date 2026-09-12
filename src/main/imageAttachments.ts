import * as fs from 'fs'
import { imagePasteShortcut } from '../renderer/src/lib/terminalAttachments.ts'
import { detectRunning } from './orchestration/workers.ts'
import type { OrchestrationStore } from './orchestration/store.ts'
import type { TerminalManager } from './terminals.ts'
import { MAX_MEDIA_BYTES, hasImageExtension, importFile, isLocalPath, type MediaFile } from './media.ts'

export { imagePasteShortcut }

/**
 * What is running inside a terminal, as a bare agent name.
 *
 * A live dispatch names its agent outright. Otherwise the same tail sniffing
 * the worker listing uses answers it, minus the `~` that marks a guess there.
 */
export function terminalAgent(
  deps: { terminals: TerminalManager; orchestration: OrchestrationStore },
  id: string
): string | undefined {
  const dispatch = deps.orchestration
    .listDispatches()
    .find((d) => d.state === 'running' && d.terminalId === id)
  if (dispatch?.agent) return dispatch.agent
  const terminal = deps.terminals.list().find((t) => t.id === id)
  let tail: string | null = null
  try {
    tail = deps.terminals.tailOutput(id, 4_000)
  } catch {

  }
  return detectRunning(terminal?.title ?? id, tail)?.replace(/^~/, '')
}

/**
 * Copy an image into the media store and hand back its canonical path.
 *
 * Files sent over the control API outlive the command that sent them — mail
 * and task specs are read minutes later, and a screenshot in a temp directory
 * is gone by then — so every attachment is imported rather than referenced.
 */
export function resolveImage(source: string): MediaFile {
  const path = String(source ?? '').trim()
  if (!path) throw new Error('image path is empty')
  if (!isLocalPath(path)) throw new Error(`image path must be absolute and local: ${path}`)
  if (!hasImageExtension(path)) throw new Error(`${path} is not an image`)
  let stat: fs.Stats
  try {
    stat = fs.statSync(path)
  } catch {
    throw new Error(`no such image: ${path}`)
  }
  if (!stat.isFile()) throw new Error(`not a file: ${path}`)
  if (stat.size > MAX_MEDIA_BYTES) throw new Error(`${path} exceeds 256 MB`)
  return importFile(path)
}

export type AttachmentMode = 'clipboard' | 'path'

/**
 * How each image reaches an agent's composer.
 *
 * Agent CLIs read the clipboard asynchronously, so only a lone image can go
 * through it — a second write would overwrite the first before it is
 * consumed. A batch, or a terminal running something with no image paste at
 * all, gets durable paths typed instead. Same rule as a drag-and-drop into
 * the terminal widget (see terminalAttachments.ts).
 */
export function attachmentMode(count: number, shortcut: string | null): AttachmentMode {
  return count === 1 && shortcut ? 'clipboard' : 'path'
}

/** Quoted for a composer, the way a dropped file is pasted. */
export function pathToken(path: string): string {
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error('image path contains control characters')
  return `"${path.replace(/"/g, '\\"')}" `
}

/**
 * Pause between the paste keystroke and whatever is typed next.
 *
 * The agent TUI reads the clipboard when it sees the shortcut; text arriving
 * inside that window lands before the image is attached, or is swallowed by
 * the repaint that follows it.
 */
export const IMAGE_PASTE_SETTLE_MS = 500
