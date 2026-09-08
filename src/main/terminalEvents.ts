import { app } from 'electron'
import type { TerminalManager } from './terminals.ts'
import type { TerminalStreamBatcher } from './terminalBatcher.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { CanvasStore } from './canvasState.ts'
import type { CodeStore } from './codeState.ts'
import type { TerminalSnapshots } from './terminalSnapshots.ts'
import { focusedTerminalId, isTerminalMounted } from './ipc/index.ts'

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

  terminals.on('data', (id: string, chunk: string) => {
    terminalBatcher.push(id, chunk)
  })
  terminalBatcher.on('batch', (id: string, chunk: string) => {
    if (isTerminalMounted(id)) send('terminal:onData', id, chunk)
  })
  terminals.on('exit', (id: string, codeVal: number) => {
    terminalBatcher.flush(id)
    send('terminal:onExit', id, codeVal)
  })
  terminals.on('release', (info: { id: string; title: string; cwd: string; scrollback: string }) => {
    if (isShuttingDown()) return
    snapshots.saveAsync({ id: info.id, title: info.title, cwd: info.cwd, scrollback: info.scrollback })
  })
  planner.on('change', (items) => send('planner:onChange', items))
  canvas.on('change', (snapshot) => send('canvas:onChange', snapshot))
  code.on('change', (snapshot) => send('code:onChange', snapshot))
}

export function setupKeyboardShortcuts(terminals: TerminalManager): void {
  app.on('browser-window-created', (_, window) => {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isComposing) return
      const termId = focusedTerminalId()
      if (termId && isTerminalMounted(termId)) {
        if (input.control && input.key.toLowerCase() === 'c') {
          event.preventDefault()
          terminals.write(termId, '\x03')
          return
        }
      }
      const isControlOrMeta = process.platform === 'darwin' ? input.meta : input.control
      if (isControlOrMeta && ['c', 'v', 'x', 'z', 'a', 'r', 'w'].includes(input.key.toLowerCase())) {
        return
      }
    })
  })
}
