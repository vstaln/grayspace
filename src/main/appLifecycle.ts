import { app } from 'electron'
import { clearRuntimePresence } from './runtimePresence.ts'
import { cancelPendingProcessTreeSweeps } from './procTree.ts'
import type { TerminalManager } from './terminals.ts'
import type { TerminalSnapshots } from './terminalSnapshots.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { CanvasStore } from './canvasState.ts'
import type { CodeStore } from './codeState.ts'
import type { OrchestrationStore } from './orchestration/store.ts'
import type { Core } from './core/index.ts'

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
        const scrollback = terminals.fullOutput(info.id) ?? ''
        if (scrollback || !snapshots.get(info.id)) {
          snapshots.save({
            id: info.id,
            title: info.title,
            cwd: info.cwd,
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
      snapshots.flushNow()
    } catch (err) {
      console.error('failed to flush terminal snapshots', err)
    }
  }
}

export function setupLifecycle(deps: {
  terminals: TerminalManager
  snapshots: TerminalSnapshots
  planner: PlannerStore
  canvas: CanvasStore
  code: CodeStore
  core: Core
  orchestration: OrchestrationStore
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
    canvas,
    code,
    core,
    orchestration,
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
    cancelPendingProcessTreeSweeps()
    const sig = getOrchestrationSignal()
    if (sig !== null) {
      clearTimeout(sig)
      setOrchestrationSignal(null)
    }
    snapshotTerminals(terminals, snapshots, code, canvas)
    snapshots.beginShutdown()
    try {
      const server = getControlServer()
      server?.close()




      server?.closeAllConnections?.()
    } catch {

    }
    setControlServer(null)
    clearRuntimePresence()




    terminals.disposeAll()
    cancelPendingProcessTreeSweeps()
    planner.dispose()
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
