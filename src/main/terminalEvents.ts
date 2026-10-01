import { app } from 'electron'
import type { TerminalManager } from './terminals.ts'
import type { TerminalStreamBatcher } from './terminalBatcher.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { NotesStore } from './notesStore.ts'
import type { CanvasStore } from './canvasState.ts'
import type { CodeStore } from './codeState.ts'
import { SNAPSHOT_TAIL_BYTES, type TerminalSnapshots } from './terminalSnapshots.ts'
import { isTerminalMounted } from './ipc/index.ts'

export function setupTerminalEvents(deps: {
  terminals: TerminalManager
  terminalBatcher: TerminalStreamBatcher
  snapshots: TerminalSnapshots
  planner: PlannerStore
  notes: NotesStore
  canvas: CanvasStore
  code: CodeStore
  send: (channel: string, ...args: unknown[]) => void
  isShuttingDown: () => boolean
}): void {
  const { terminals, terminalBatcher, snapshots, planner, notes, canvas, code, send, isShuttingDown } = deps
  let outputDeliveryId = 0

  const snapshotDebounce = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * A terminal that never stops streaming would never reach the trailing edge
   * of the debounce, so a save is forced this long after the first unsaved
   * byte. Everything in between is skipped, which is the whole point: the
   * tail join above runs on the thread that pumps every PTY.
   */
  const SNAPSHOT_MAX_INTERVAL_MS = 15000
  const snapshotDeadline = new Map<string, number>()
  const saveSnapshot = (id: string): void => {
    snapshotDebounce.delete(id)
    snapshotDeadline.delete(id)
    if (isShuttingDown()) return
    const recent = terminals.tailOutput(id, SNAPSHOT_TAIL_BYTES)
    if (recent === null) return
    const info = terminals.info(id)
    snapshots.saveAsync({
      id,
      title: info?.title || id,
      cwd: info?.cwd || '',
      lastPrompt: info?.lastPrompt,
      scrollback: recent
    })
  }
  terminals.on('data', (id: string, chunk: string) => {
    terminalBatcher.push(id, chunk)
    // Trailing debounce: a burst of output costs one save once it settles,
    // where a leading debounce charged one every 1.5s for as long as the
    // burst lasted.
    const existing = snapshotDebounce.get(id)
    if (existing !== undefined) {
      if (Date.now() >= (snapshotDeadline.get(id) ?? 0)) return
      clearTimeout(existing)
    } else {
      snapshotDeadline.set(id, Date.now() + SNAPSHOT_MAX_INTERVAL_MS)
    }
    const timer = setTimeout(() => saveSnapshot(id), 1500)
    timer.unref?.()
    snapshotDebounce.set(id, timer)
  })
  // Straight to the renderer. A second queue used to sit here pacing output to
  // 16KB per 32ms tick, which is ~500KB/s — far below what an agent streaming a
  // diff produces. Output is acknowledged only after xterm parses it; the PTY
  // pauses above the renderer high-water mark, so transport never evicts bytes.
  terminalBatcher.on('batch', (id: string, chunk: string) => {
    if (!isTerminalMounted(id)) return
    outputDeliveryId += 1
    terminals.noteRendererOutput(id, chunk.length, outputDeliveryId)
    send('terminal:onData', id, chunk, outputDeliveryId)
  })
  const cancelSnapshotTimer = (id: string): void => {
    const timer = snapshotDebounce.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      snapshotDebounce.delete(id)
    }
    snapshotDeadline.delete(id)
  }
  terminals.on('exit', (id: string, codeVal: number) => {
    cancelSnapshotTimer(id)
    terminalBatcher.flush(id)
    send('terminal:onExit', id, codeVal)
    if (!isShuttingDown()) {
      const full = terminals.fullOutput(id)
      if (full !== null) {
        const info = terminals.info(id)
        snapshots.saveAsync({
          id,
          title: info?.title || id,
          cwd: info?.cwd || '',
          lastPrompt: info?.lastPrompt,
          scrollback: full
        })
      }
    }
  })
  terminals.on('title', (id: string, title: string) => {
    send('control:rename-widget', { id, title })
  })
  terminals.on('prompt', (id: string, prompt: string) => {
    send('terminal:onPrompt', id, prompt)
  })
  // The per-write correlation (RustPtySidecar.write) already surfaces a
  // rejected keystroke inline in its own terminal. This is the remaining
  // case: an operational failure with no specific terminal to attach to
  // (a stdin error, a crashed sidecar process) that would otherwise only
  // ever reach a console.warn with nobody watching.
  terminals.on('backend-error', (error: unknown) => {
    send('terminal:onBackendError', error instanceof Error ? error.message : String(error))
  })
  terminals.on('release', (info: { id: string; title: string; cwd: string; scrollback: string; lastPrompt?: string }) => {
    cancelSnapshotTimer(info.id)
    terminalBatcher.flush(info.id)
    if (isShuttingDown()) return
    snapshots.saveAsync({ id: info.id, title: info.title, cwd: info.cwd, lastPrompt: info.lastPrompt, scrollback: info.scrollback })
  })
  planner.on('change', (items) => send('planner:onChange', items))
  notes.on('change', (items) => send('notes:onChange', items))
  canvas.on('change', (snapshot) => send('canvas:onChange', snapshot))
  code.on('change', (snapshot) => send('code:onChange', snapshot))
}

export function setupKeyboardShortcuts(_terminals: TerminalManager): void {
  app.on('browser-window-created', (_, window) => {
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.isComposing) return
      // NOTE: Escape / Ctrl-C are delivered to the pty via xterm onData when
      // a terminal is actually focused. Hijacking them here by
      // focusedTerminalId() breaks Settings modals, canvas inputs and the
      // browser omnibox, so global shortcuts must not send input to the pty.
      const isControlOrMeta = process.platform === 'darwin' ? input.meta : input.control
      if (isControlOrMeta && ['c', 'v', 'x', 'z', 'a', 'r', 'w'].includes(input.key.toLowerCase())) {
        return
      }
    })
  })
}
