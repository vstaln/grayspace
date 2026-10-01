import { app } from 'electron'
import { clearRuntimePresence } from './runtimePresence.ts'
import { cancelPendingProcessTreeSweeps } from './procTree.ts'
import type { TerminalManager } from './terminals.ts'
import type { TerminalSnapshots } from './terminalSnapshots.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { NotesStore } from './notesStore.ts'
import type { CanvasStore } from './canvasState.ts'
import type { CodeStore } from './codeState.ts'
import type { OrchestrationStore } from './orchestration/store.ts'
import type { AppState } from './appState.ts'
import type { Core } from './core/index.ts'
import type { RendererStateStore } from './rendererState.ts'
import { SNAPSHOT_TAIL_BYTES } from './terminalSnapshots.ts'
import { closeRealBrowser } from './realBrowser.ts'

/**
 * How much scrollback the shutdown snapshot reads per terminal — the same
 * bound the periodic snapshot uses.
 *
 * TerminalSnapshots.prepare() strips the text and then keeps only its last
 * MAX_SCROLLBACK_BYTES, so reading the whole ring buffer here was work whose
 * result was immediately thrown away — and it happened inside `before-quit`,
 * where the window is already unresponsive and every millisecond is visible
 * as the app refusing to close. With a full buffer per terminal that is up to
 * half a megabyte joined and character-scanned, times every open terminal, on
 * the main thread.
 */
const SHUTDOWN_SNAPSHOT_TAIL_BYTES = SNAPSHOT_TAIL_BYTES

export function snapshotTerminals(
  terminals: TerminalManager,
  snapshots: TerminalSnapshots,
  code?: CodeStore,
  canvas?: CanvasStore
): void {
  const live = new Set<string>()
  try {
    for (const info of terminals.list()) {
      try {
        live.add(info.id)
        const scrollback = terminals.tailOutput(info.id, SHUTDOWN_SNAPSHOT_TAIL_BYTES) ?? ''
        if (scrollback || !snapshots.get(info.id)) {
          snapshots.save({
            id: info.id,
            title: info.title,
            cwd: info.cwd,
            lastPrompt: info.lastPrompt,
            scrollback
          })
        }
      } catch (err) {
        console.error(`failed to snapshot terminal ${info.id}`, err)
      }
    }
  } finally {
    try {
      if (code) {
        for (const s of code.snapshot().sessions) {
          live.add(s.id)
        }
      }
      if (canvas) {
        for (const w of canvas.snapshot().widgets) {
          if (w.kind === 'terminal') live.add(w.id)
        }
      }
      snapshots.prune(live)
      // `before-quit` is synchronous, so the drain this returns cannot be
      // awaited here. flushNow() writes the index synchronously before it
      // returns, which is the part that has to land.
      void snapshots.flushNow()
    } catch (err) {
      console.error('failed to flush terminal snapshots', err)
    }
  }
}

export function setupLifecycle(deps: {
  terminals: TerminalManager
  snapshots: TerminalSnapshots
  planner: PlannerStore
  notes: NotesStore
  canvas: CanvasStore
  code: CodeStore
  core: Core
  orchestration: OrchestrationStore
  state: AppState
  rendererState: RendererStateStore
  getControlServer: () => { close(): void; closeAllConnections?(): void } | null
  setControlServer: (v: { close(): void; closeAllConnections?(): void } | null) => void
  getOrchestrationSignal: () => ReturnType<typeof setTimeout> | null
  setOrchestrationSignal: (v: ReturnType<typeof setTimeout> | null) => void
  isShuttingDown: () => boolean
  setShuttingDown: (v: boolean) => void
}): void {
  const {
    terminals,
    snapshots,
    planner,
    notes,
    canvas,
    code,
    core,
    orchestration,
    state,
    rendererState,
    getControlServer,
    setControlServer,
    getOrchestrationSignal,
    setOrchestrationSignal
  } = deps

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    app.quit()
  })

  app.on('before-quit', () => {
    if (deps.isShuttingDown()) return
    deps.setShuttingDown(true)
    const sig = getOrchestrationSignal()
    if (sig !== null) {
      clearTimeout(sig)
      setOrchestrationSignal(null)
    }
    // beginShutdown() first: it stops new debounced saves from being queued
    // behind us and writes whatever the pending one was holding, so the
    // synchronous snapshot below is the last word rather than racing an async
    // write that may or may not land. It also leaves flushNow(), at the end of
    // snapshotTerminals(), as the only other index write on this path.
    snapshots.beginShutdown()
    snapshotTerminals(terminals, snapshots, code, canvas)
    try {
      state.flush()
    } catch (err) {
      console.error('failed to flush workspace state', err)
    }
    try {
      const server = getControlServer()
      server?.close()




      server?.closeAllConnections?.()
    } catch {

    }
    setControlServer(null)
    try {
      closeRealBrowser()
    } catch {

    }
    clearRuntimePresence()




    terminals.disposeAll()
    // After disposeAll, not before: killing the ptys is what schedules the
    // sweeps, so cancelling first leaves a debounced timer and a child process
    // pending across the quit.
    cancelPendingProcessTreeSweeps()
    planner.dispose()
    notes.dispose()
    rendererState.dispose()
    orchestration.dispose()
    canvas.dispose()
    code.dispose()
    core.dispose()
  })

  process.on('SIGINT', () => {
    app.quit()
  })
  process.on('SIGTERM', () => {
    app.quit()
  })
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason)
  })
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err)
  })
}
