import { CommandError, parseResource } from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function terminalIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'terminal') throw new CommandError('invalid', `${target} is not a terminal`)
  return parsed.id
}

/**
 * Terminals are the one resource where a lock protects something outside the
 * app entirely: two actors typing into the same shell interleave their
 * keystrokes into a single command line, and the result is neither actor's
 * command. So `terminal.write` goes through the same gate as everything else,
 * and an agent that wants a whole session holds the lock across its turns.
 */
export function registerTerminalCommands({ core, terminals, requestWidget, requestWidgetRemoval, defaultCwd }: CommandDeps): void {
  const { bus } = core

  bus.register<{ title?: string; cwd?: string; agentOwned?: boolean }, { id: string; title: string; cwd: string; ready: boolean }>(
    'terminal.create',
    {
      ignoreVersion: true,
      apply: async ({ command }) => {
        const p = command.payload ?? {}
        const info = terminals.reserve({
          title: p.title,
          cwd: p.cwd || defaultCwd(),
          prefix: p.agentOwned ? 'agent' : 'term'
        })
        requestWidget({ id: info.id, title: info.title })
        const ready = await terminals.waitUntilRunning(info.id)
        if (!ready) {
          // The renderer never mounted a widget for this id (window still
          // starting, or closed). Drop the reservation rather than leave a
          // terminal that `list()` reports but no process or window backs.
          terminals.dispose(info.id)
          requestWidgetRemoval(info.id)
          throw new CommandError('failed', 'the OrcSpace window did not open a terminal for this request', {
            id: info.id
          })
        }
        return { id: info.id, title: info.title, cwd: info.cwd, ready }
      }
    }
  )

  /**
   * Starts the pty for a widget the renderer has already mounted. Separate
   * from `terminal.create` because the direction is reversed: there the app
   * asks the window for a widget, here the window reports one that exists and
   * supplies the real cols/rows, which must be known before the shell starts
   * or full-screen TUIs render against the wrong geometry.
   */
  bus.register<{ cols?: number; rows?: number; cwd?: string }, { ok: boolean; error?: string }>('terminal.spawn', {
    ignoreVersion: true,
    apply: ({ command }) => {
      const p = command.payload ?? {}
      return terminals.spawn(terminalIdOf(command.target), p.cols, p.rows, p.cwd || defaultCwd())
    }
  })

  bus.register<{ text: string; pressEnter?: boolean }, { ok: true }>('terminal.write', {
    ignoreVersion: true,
    apply: async ({ command }) => {
      const id = terminalIdOf(command.target)
      if (!(await terminals.waitUntilRunning(id))) throw new CommandError('not_found', 'terminal not found')
      const text = typeof command.payload?.text === 'string' ? command.payload.text : ''
      terminals.write(id, text + (command.payload?.pressEnter === false ? '' : '\r'))
      return { ok: true }
    }
  })

  /** Raw keystrokes from the widget that owns the terminal — no Enter added. */
  bus.register<{ data: string }, { ok: true }>('terminal.input', {
    ignoreVersion: true,
    apply: ({ command }) => {
      terminals.write(terminalIdOf(command.target), String(command.payload?.data ?? ''))
      return { ok: true }
    }
  })

  bus.register<{ cols: number; rows: number }, { ok: true }>('terminal.resize', {
    // Geometry follows the widget that renders the pty; it is not contended
    // state, and blocking it on a lock would break resize while an agent works.
    requiresLock: false,
    ignoreVersion: true,
    apply: ({ command }) => {
      terminals.resize(terminalIdOf(command.target), Number(command.payload?.cols), Number(command.payload?.rows))
      return { ok: true }
    }
  })

  bus.register<Record<string, never>, { id: string }>('terminal.dispose', {
    ignoreVersion: true,
    apply: ({ command }) => {
      const id = terminalIdOf(command.target)
      terminals.dispose(id)
      requestWidgetRemoval(id)
      return { id }
    }
  })
}
