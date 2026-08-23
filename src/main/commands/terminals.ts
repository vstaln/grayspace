import { CommandError, parseResource } from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function terminalIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'terminal') throw new CommandError('invalid', `${target} is not a terminal`)
  return parsed.id
}

/**
 * Models put the line in `text`, but also invent `command` / `input` / `content`.
 * Accept any of them so "type claude" does not become a silent empty Enter.
 */
function extractTerminalText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as Record<string, unknown>
  for (const key of ['text', 'command', 'input', 'content', 'line'] as const) {
    const value = p[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * Terminals are the one resource where a lock protects something outside the
 * app entirely: two actors typing into the same shell interleave their
 * keystrokes into a single command line, and the result is neither actor's
 * command. So `terminal.write` goes through the same gate as everything else,
 * and an agent that wants a whole session holds the lock across its turns.
 */
export function registerTerminalCommands({
  core,
  terminals,
  snapshots,
  requestWidget,
  requestWidgetRemoval,
  originWidgetId,
  forgetOrigin,
  defaultCwd
}: CommandDeps): void {
  const { bus } = core

  bus.registerDefinition<
    { title?: string; cwd?: string; agentOwned?: boolean },
    { id: string; title: string; cwd: string; ready: boolean }
  >({
    type: 'terminal.create',
    description:
      'Ask the app window for a new terminal widget and wait for its shell to start. Returns the real terminal id.',
    targetScheme: 'terminal',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tab/window label' },
        cwd: { type: 'string', description: 'Working directory (defaults to the open project)' },
        agentOwned: { type: 'boolean', description: 'true marks the shell as spawned by an agent' }
      }
    },
    handler: {
      apply: async ({ command, unblock, signal }) => {
        const p = command.payload ?? {}
        const info = terminals.reserve({
          title: p.title,
          cwd: p.cwd || defaultCwd(),
          prefix: p.agentOwned ? 'agent' : 'term'
        })
        // Only an agent's terminal gets a link drawn: one the user opened by
        // hand came from the toolbar, not from another shell, and tying it to
        // whatever they last clicked would be a line that means nothing.
        requestWidget({ id: info.id, title: info.title, from: p.agentOwned ? originWidgetId() : null })
        // The widget answers with `terminal.spawn`, which is a command like any
        // other and would queue behind this one. Waiting for it while still
        // holding the turn deadlocks every agent-created terminal into its own
        // timeout, so the queue is handed on before the wait begins.
        unblock()
        // The default 3s timeout assumes a window that's already up. Right
        // after app launch — which is exactly when the startup auto-launch in
        // index.ts calls this — the renderer is often still loading (first
        // paint, preload, IPC handshake), especially on a dev build's first
        // run; 3s alone made that "Claude" terminal fail to open more often
        // than not. Match terminal.write's patience for the same wait.
        const ready = await terminals.waitUntilRunning(info.id, 10_000, signal)
        if (!ready) {
          // The renderer never mounted a widget for this id (window still
          // starting, closed, or another actor disposed the reservation while
          // we waited). Drop the reservation rather than leave a terminal that
          // `list()` reports but no process or window backs.
          terminals.dispose(info.id)
          requestWidgetRemoval(info.id)
          throw new CommandError('failed', 'the OrcSpace window did not open a terminal for this request', {
            id: info.id
          })
        }
        return { id: info.id, title: info.title, cwd: info.cwd, ready }
      }
    }
  })

  /**
   * Starts the pty for a widget the renderer has already mounted. Separate
   * from `terminal.create` because the direction is reversed: there the app
   * asks the window for a widget, here the window reports one that exists and
   * supplies the real cols/rows, which must be known before the shell starts
   * or full-screen TUIs render against the wrong geometry.
   */
  bus.registerDefinition<
    { cols?: number; rows?: number; cwd?: string },
    { ok: boolean; error?: string; scrollback?: string; live?: boolean }
  >({
    type: 'terminal.spawn',
    description: 'Start (or reconnect) the pty behind a mounted terminal widget.',
    targetScheme: 'terminal',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        cols: { type: 'number' },
        rows: { type: 'number' },
        cwd: { type: 'string' }
      }
    },
    handler: {
      apply: ({ command }) => {
        const id = terminalIdOf(command.target)
        const p = command.payload ?? {}
        // Two outcomes when the widget mounts:
        // 1) Reconnect — the process is still running (user switched project
        //    folders and came back, or React remounted). Return the live
        //    buffer; do not claim the session was restarted.
        // 2) Fresh / after death — paint disk snapshot as static text and
        //    start a new shell. The old process is gone; pretending otherwise
        //    (a dead `npm run dev` that answers nothing) is worse.
        const saved = snapshots.get(id)
        const result = terminals.spawn(id, p.cols, p.rows, p.cwd || saved?.cwd || defaultCwd())
        // A failed spawn must fail the command, not be journaled as a success
        // with `{ok:false}` as the result data (AUD-10).
        if (!result.ok) throw new CommandError('failed', result.error ?? 'не удалось запустить терминал')
        if (result.reconnected) {
          return { ok: true, live: true, scrollback: terminals.fullOutput(id) ?? '' }
        }
        if (saved?.title) terminals.setTitle(id, saved.title)
        return { ok: true, live: false, scrollback: snapshots.scrollback(id) }
      }
    }
  })

  bus.registerDefinition<
    { text?: string; command?: string; input?: string; content?: string; pressEnter?: boolean },
    { ok: true; id: string; text: string }
  >({
    type: 'terminal.write',
    description:
      'Type one line into a terminal and press Enter. Accepts text/command/input/content aliases; embedded newlines are collapsed.',
    targetScheme: 'terminal',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The line to type' },
        command: { type: 'string', description: 'Alias of text' },
        input: { type: 'string', description: 'Alias of text' },
        content: { type: 'string', description: 'Alias of text' },
        pressEnter: { type: 'boolean', description: 'Submit after typing (default true)' }
      }
    },
    handler: {
      apply: async ({ command, unblock, signal }) => {
        let id = terminalIdOf(command.target)
        // Models often keep saying terminal:new on a later turn, or invent an
        // id. Prefer a live shell over a dead/missing target so "type claude"
        // actually reaches the open pane.
        if (!terminals.isRunning(id)) {
          const resolved = terminals.resolveWriteTarget(id === 'new' ? '' : id)
          if (resolved) id = resolved
        }
        const resource = `terminal:${id}`
        if (core.locks.isLockedByOther(resource, command.actorId)) {
          const lock = core.locks.holder(resource)
          throw new CommandError('locked', `${resource} is locked by ${lock?.actorId}`, { lock })
        }
        let extraLock = false
        if (!core.locks.isHeldBy(resource, command.actorId)) {
          core.locks.acquire({
            resource,
            actorId: command.actorId,
            reason: 'terminal.write',
            implicit: true
          })
          extraLock = true
        }
        try {
          // Same deadlock as `terminal.create`: a write aimed at a terminal whose
          // widget is still mounting has to let that widget's `terminal.spawn`
          // through, or it waits out the timeout for a pty stuck behind it.
          if (!terminals.isRunning(id)) unblock()
          if (!(await terminals.waitUntilRunning(id, 8_000, signal))) {
            throw new CommandError('not_found', `terminal not running (wanted ${command.target})`, {
              requested: command.target,
              resolved: id
            })
          }
          const text = extractTerminalText(command.payload)
          if (!text) {
            throw new CommandError(
              'invalid',
              'terminal.write needs non-empty text (payload.text) — nothing to type'
            )
          }
          // A TUI reading raw pty input (Claude Code, opencode, …) commonly
          // treats a burst of many characters — including any \r/\n inside it
          // — as a paste rather than keystrokes, and stops trusting embedded
          // newlines to mean "submit". A caller's text (voice dictation,
          // multi-sentence instructions) can itself contain line breaks, so
          // this collapses it to one physical line first: a "line" is what
          // this command types, by contract, and a newline mid-text has never
          // been anything other than an accident of the source.
          const singleLine = text.replace(/\r\n|\r|\n/g, ' ')
          const written = terminals.write(id, singleLine)
          if (!written.ok) throw new CommandError('failed', written.error)
          if (command.payload?.pressEnter !== false) {
            // Sent as its own write, after the paste-detection window has had
            // a moment to close, so it reads as a genuine keypress instead of
            // more paste content — the same burst that types the text can
            // otherwise swallow an Enter appended right after it, leaving the
            // line sitting typed but never submitted (AUD-11).
            await new Promise((resolve) => setTimeout(resolve, 30))
            // Windows conpty is happier with CRLF for "Enter"; bare \r sometimes
            // only moves the cursor and the shell never runs the line.
            const enter = process.platform === 'win32' ? '\r\n' : '\r'
            const enterWritten = terminals.write(id, enter)
            if (!enterWritten.ok) throw new CommandError('failed', enterWritten.error)
          }
          // Let the shell (and ConPTY echo) catch up before the next plan step
          // piles another line on top — sequential "opencode" then "hello" races.
          await new Promise((resolve) => setTimeout(resolve, 180))
          return { ok: true as const, id, text: singleLine }
        } finally {
          if (extraLock) {
            try {
              core.locks.release(resource, command.actorId)
            } catch {
              /* handler or TTL may have dropped it */
            }
          }
        }
      }
    }
  })

  /**
   * Raw keystrokes from the widget that owns the terminal — no Enter added.
   *
   * The single highest-frequency command in the app: one per keypress, per
   * terminal, plus one per pasted block. `transient` keeps it out of the
   * journal (a keystroke is not state to replay — it is already in the pty)
   * and `bypassQueue` keeps it off the contended lanes entirely, so typing
   * never waits on an agent's paced `terminal.write`, even in the same shell:
   * cross-actor exclusion comes from the lock gate below, which still runs —
   * an agent holding `terminal:<id>` still locks the user out.
   */
  bus.registerDefinition<{ data: string }, { ok: true }>({
    type: 'terminal.input',
    description: '(Internal) raw keystrokes from the owning widget — no Enter added.',
    targetScheme: 'terminal',
    ignoreVersion: true,
    transient: true,
    bypassQueue: true,
    payloadSchema: {
      type: 'object',
      required: ['data'],
      properties: { data: { type: 'string' } }
    },
    handler: {
      apply: ({ command }) => {
        const id = terminalIdOf(command.target)
        const data = String(command.payload?.data ?? '')
        const written = terminals.write(id, data)
        if (!written.ok) throw new CommandError('failed', written.error)
        return { ok: true }
      }
    }
  })

  bus.registerDefinition<{ cols: number; rows: number }, { ok: true }>({
    type: 'terminal.resize',
    description: '(Internal) resize a terminal widget’s pty geometry.',
    targetScheme: 'terminal',
    requiresLock: false,
    ignoreVersion: true,
    transient: true,
    bypassQueue: true,
    payloadSchema: {
      type: 'object',
      required: ['cols', 'rows'],
      properties: { cols: { type: 'number' }, rows: { type: 'number' } }
    },
    handler: {
      apply: ({ command }) => {
        terminals.resize(terminalIdOf(command.target), Number(command.payload?.cols), Number(command.payload?.rows))
        return { ok: true }
      }
    }
  })

  bus.registerDefinition<Record<string, never>, { id: string }>({
    type: 'terminal.dispose',
    description: 'Kill a terminal’s shell process and drop its snapshot.',
    targetScheme: 'terminal',
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => {
        const id = terminalIdOf(command.target)
        terminals.dispose(id)
        // A terminal the user closed is not coming back; its saved screen would
        // only be restored onto a widget that no longer exists.
        snapshots.forget(id)
        // Nor should it anchor the next agent terminal's connection line.
        forgetOrigin(id)
        requestWidgetRemoval(id)
        return { id }
      }
    }
  })
}
