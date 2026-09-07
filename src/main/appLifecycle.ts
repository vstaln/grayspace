import { app } from 'electron'
import { clearRuntimePresence } from './runtimePresence.ts'
import { cancelPendingProcessTreeSweeps } from './procTree.ts'
import type { TerminalManager } from './terminals.ts'
import type { TerminalSnapshots } from './terminalSnapshots.ts'
import type { CoordinationStore } from './coordination.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { CanvasStore } from './canvasState.ts'
import type { CodeStore } from './codeState.ts'
import type { OrchestrationStore } from './orchestration/store.ts'
import type { Core } from './core/index.ts'
import type { ChatRunner } from './chatRunner.ts'

export function snapshotTerminals(terminals: TerminalManager, snapshots: TerminalSnapshots): void {
  const live = new Set<string>()
  try {
    for (const info of terminals.list()) {
      try {
        live.add(info.id)
        snapshots.save({
          id: info.id,
          title: info.title,
          cwd: info.cwd,
          scrollback: terminals.fullOutput(info.id) ?? ''
        })
      } catch (err) {
        // One bad terminal (vanished pty, unreadable scrollback) must not
        // abort the whole shutdown snapshot or skip the server/store disposes.
        console.error(`failed to snapshot terminal ${info.id}`, err)
      }
    }
  } finally {
    try {
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
  coordination: CoordinationStore
  planner: PlannerStore
  canvas: CanvasStore
  code: CodeStore
  chat: ChatRunner
  core: Core
  orchestration: OrchestrationStore
  disposePlannerSync: () => void
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
    coordination,
    planner,
    canvas,
    code,
    chat,
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
    cancelPendingProcessTreeSweeps()
    const sig = getOrchestrationSignal()
    if (sig !== null) {
      clearTimeout(sig)
      setOrchestrationSignal(null)
    }
    snapshotTerminals(terminals, snapshots)
    snapshots.beginShutdown()
    try {
      const server = getControlServer()
      server?.close()
      // Long-poll `orc check --wait` requests and undici keep-alive sockets
      // must not keep Electron alive after the window has closed. `close()`
      // stops new requests but intentionally waits for active/idle sockets;
      // shutdown is the one place where aborting them is the safe behavior.
      server?.closeAllConnections?.()
    } catch {
      /* already closed */
    }
    setControlServer(null)
    clearRuntimePresence()
    // node-pty already terminates the shell and its console process list.
    // Do not start the delayed taskkill/WMI sweep while Electron is exiting:
    // that detached sweep can outlive this instance and race a recycled PID
    // (including the Windows shell/Explorer when two app copies close).
    terminals.disposeAll({ killDescendants: false })
    cancelPendingProcessTreeSweeps()
    disposePlannerSync()
    coordination.dispose()
    planner.dispose()
    orchestration.dispose()
    canvas.dispose()
    code.dispose()
    chat.disposeAll()
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
