import { CommandError, parseResource } from '../core/index.ts'
import { isDefaultTerminalTitle } from '../terminalNames.ts'
import type { CommandDeps } from './index.ts'
import { failTerminalDispatches } from './orchestration.ts'

function terminalIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'terminal') throw new CommandError('invalid', `${target} is not a terminal`)
  return parsed.id
}





function extractTerminalText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as Record<string, unknown>
  for (const key of ['text', 'command', 'input', 'content', 'line'] as const) {
    const value = p[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}








export function registerTerminalCommands({
  core,
  terminals,
  snapshots,
  orchestration,
  requestWidget,
  requestWidgetRemoval,
  originWidgetId,
  forgetOrigin,
  defaultCwd
}: CommandDeps): void {
  const { flow } = core

  flow.registerDefinition<
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



        requestWidget({ id: info.id, title: info.title, from: p.agentOwned ? originWidgetId() : null })




        unblock()






        const ready = await terminals.waitUntilRunning(info.id, 10_000, signal)
        if (!ready) {




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








  flow.registerDefinition<
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







        const saved = snapshots.get(id)
        const result = terminals.spawn(id, p.cols, p.rows, p.cwd || saved?.cwd || defaultCwd())


        if (!result.ok) throw new CommandError('failed', result.error ?? 'failed to start the terminal')
        if (result.reconnected) {
          return { ok: true, live: true, scrollback: terminals.fullOutput(id) ?? '' }
        }
        if (saved?.title && saved.title !== id && !isDefaultTerminalTitle(saved.title)) {
          terminals.setTitle(id, saved.title, { unique: true })
        }
        return { ok: true, live: false, scrollback: snapshots.scrollback(id) }
      }
    }
  })

  flow.registerDefinition<
    {
      text?: string
      command?: string
      input?: string
      content?: string
      pressEnter?: boolean
      confirmDelivery?: boolean
      deliveryTimeoutMs?: number
    },
    {
      ok: true
      id: string
      text: string
      delivery?: { id: string; status: 'delivered'; confirmedAt: number; evidence: 'terminal-output' }
    }
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
        pressEnter: { type: 'boolean', description: 'Submit after typing (default true)' },
        confirmDelivery: { type: 'boolean', description: 'Wait for observable target-terminal output before reporting success' },
        deliveryTimeoutMs: { type: 'number', description: 'Receipt timeout in milliseconds' }
      }
    },
    handler: {
      apply: async ({ command, unblock, signal }) => {
        let id = terminalIdOf(command.target)



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








          const singleLine = text.replace(/\r\n|\r|\n/g, ' ')
          if (command.payload?.confirmDelivery === true) {
            const receipt = await terminals.deliverLine(id, singleLine, {
              pressEnter: command.payload?.pressEnter !== false,
              timeoutMs: command.payload?.deliveryTimeoutMs,
              signal
            })
            if (!receipt.ok) {
              throw new CommandError('failed', receipt.error, {
                deliveryId: receipt.id,
                terminalId: receipt.terminalId,
                status: 'not_sent'
              })
            }
            return {
              ok: true as const,
              id,
              text: singleLine,
              delivery: {
                id: receipt.id,
                status: 'delivered' as const,
                confirmedAt: receipt.confirmedAt,
                evidence: receipt.evidence
              }
            }
          }

          const written = await terminals.writeLine(id, singleLine, {
            pressEnter: command.payload?.pressEnter !== false,
            signal
          })
          if (!written.ok) throw new CommandError('failed', written.error)


          await new Promise((resolve) => setTimeout(resolve, 180))
          return { ok: true as const, id, text: singleLine }
        } finally {
          if (extraLock) {
            try {
              core.locks.release(resource, command.actorId)
            } catch {

            }
          }
        }
      }
    }
  })












  flow.registerDefinition<{ data: string }, { ok: true }>({
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
      apply: async ({ command }) => {
        const id = terminalIdOf(command.target)
        const data = String(command.payload?.data ?? '')
        const written = await terminals.writeInput(id, data)
        if (!written.ok) throw new CommandError('failed', written.error)
        return { ok: true }
      }
    }
  })

  flow.registerDefinition<{ cols: number; rows: number }, { ok: true }>({
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

  flow.registerDefinition<Record<string, never>, { id: string }>({
    type: 'terminal.dispose',
    description: 'Kill a terminal’s shell process and drop its snapshot.',
    targetScheme: 'terminal',
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => {
        const id = terminalIdOf(command.target)
        terminals.dispose(id)


        snapshots.forget(id)

        forgetOrigin(id)
        requestWidgetRemoval(id)
        failTerminalDispatches({ orchestration }, id)
        return { id }
      }
    }
  })
}
