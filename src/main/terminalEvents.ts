import { app } from 'electron'
import type { TerminalManager } from './terminals.ts'
import type { TerminalStreamBatcher } from './terminalBatcher.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { CanvasStore } from './canvasState.ts'
import type { CodeStore } from './codeState.ts'
import type { TerminalSnapshots } from './terminalSnapshots.ts'
import { isTerminalMounted } from './ipc/index.ts'
import { TerminalOutputGate } from './terminalStream.ts'

export function setupTerminalEvents(deps: {
  terminals: TerminalManager
  terminalBatcher: TerminalStreamBatcher
  snapshots: TerminalSnapshots
  planner: PlannerStore
  canvas: CanvasStore
  code: CodeStore
  send: (channel: string, ...args: unknown[]) => void
  isShuttingDown: () => boolean
}): void {
  const { terminals, terminalBatcher, snapshots, planner, canvas, code, send, isShuttingDown } = deps

  const snapshotDebounce = new Map<string, ReturnType<typeof setTimeout>>()
  const liveOutput = new TerminalOutputGate((id, chunk) => {
    if (isTerminalMounted(id)) send('terminal:onData', id, chunk)
  })
  terminals.on('data', (id: string, chunk: string) => {
    terminalBatcher.push(id, chunk)
    if (!snapshotDebounce.has(id)) {
      const timer = setTimeout(() => {
        snapshotDebounce.delete(id)
        if (isShuttingDown()) return
        const full = terminals.fullOutput(id)
        if (full !== null) {
          const info = terminals.list().find((t) => t.id === id)
          snapshots.saveAsync({
            id,
            title: info?.title || id,
            cwd: info?.cwd || '',
            scrollback: full
          })
        }
      }, 1500)
      timer.unref?.()
      snapshotDebounce.set(id, timer)
    }
  })
  terminalBatcher.on('batch', (id: string, chunk: string) => {
    liveOutput.enqueue(id, chunk)
  })
  const cancelSnapshotTimer = (id: string): void => {
    const timer = snapshotDebounce.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      snapshotDebounce.delete(id)
    }
  }
  terminals.on('exit', (id: string, codeVal: number) => {
    cancelSnapshotTimer(id)
    terminalBatcher.flush(id)
    liveOutput.flush(id)
    send('terminal:onExit', id, codeVal)
    if (!isShuttingDown()) {
      const full = terminals.fullOutput(id)
      if (full !== null) {
        const info = terminals.list().find((t) => t.id === id)
        snapshots.saveAsync({
          id,
          title: info?.title || id,
          cwd: info?.cwd || '',
          scrollback: full
        })
      }
    }
  })
  terminals.on('title', (id: string, title: string) => {
    send('control:rename-widget', { id, title })
  })
  terminals.on('release', (info: { id: string; title: string; cwd: string; scrollback: string }) => {
    cancelSnapshotTimer(info.id)
    terminalBatcher.flush(info.id)
    liveOutput.flush(info.id)
    if (isShuttingDown()) return
    snapshots.saveAsync({ id: info.id, title: info.title, cwd: info.cwd, scrollback: info.scrollback })
  })
  planner.on('change', (items) => send('planner:onChange', items))
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
