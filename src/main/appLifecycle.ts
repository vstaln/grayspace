import { app } from 'electron'
import { clearRuntimePresence } from './runtimePresence.ts'
import type { TerminalManager } from './terminals.ts'
import type { TerminalSnapshots } from './terminalSnapshots.ts'
import type { CoordinationStore } from './coordination.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { CanvasStore } from './canvasState.ts'
import type { CodeStore } from './codeState.ts'
import type { OrchestrationStore } from './orchestration/store.ts'
import type { Core } from './core/index.ts'

export function snapshotTerminals(terminals: TerminalManager, snapshots: TerminalSnapshots): void {
  const live = new Set<string>()
  for (const info of terminals.list()) {
    live.add(info.id)
    snapshots.save({
      id: info.id,
      title: info.title,
      cwd: info.cwd,
      scrollback: terminals.fullOutput(info.id) ?? ''
    })
  }
  snapshots.prune(live)
  snapshots.flushNow()
}

export function setupLifecycle(deps: {
  terminals: TerminalManager
  snapshots: TerminalSnapshots
  coordination: CoordinationStore
  planner: PlannerStore
  canvas: CanvasStore
  code: CodeStore
  core: Core
  orchestration: OrchestrationStore
  disposePlannerSync: () => void
  getControlServer: () => { close(): void } | null
  setControlServer: (v: { close(): void } | null) => void
  getOrchestrationSignal: () => ReturnType<typeof setTimeout> | null
  setOrchestrationSignal: (v: ReturnType<typeof setTimeout> | null) => void
  isShuttingDown: () => boolean
  setShuttingDown: (v: boolean) => void
}): void {
  const {
    terminals,
    snapshots,
    coordination,
    planner,
    canvas,
    code,
    core,
    orchestration,
    disposePlannerSync,
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
    snapshotTerminals(terminals, snapshots)
    snapshots.beginShutdown()
    try {
      getControlServer()?.close()
    } catch {
      /* already closed */
    }
    setControlServer(null)
    clearRuntimePresence()
    terminals.disposeAll()
    disposePlannerSync()
    coordination.dispose()
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
