import { readFileSync } from 'fs'
import { CommandError, parseResource } from '../core/index.ts'
import {
  IMAGE_PASTE_SETTLE_MS,
  attachmentMode,
  imagePasteShortcut,
  pathToken,
  resolveImage,
  terminalAgent,
  type AttachmentMode
} from '../imageAttachments.ts'
import { stageClipboardImage, type MediaFile } from '../media.ts'
import { isDefaultTerminalTitle } from '../terminalNames.ts'
import { preferredTerminalCwd } from '../terminal/terminalWorkingDirectory.ts'
import type { CommandDeps } from './index.ts'
import { failTerminalDispatches } from './orchestration.ts'


function settle(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
}

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
    { cols?: number; rows?: number; cwd?: string; title?: string },
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
        cwd: { type: 'string' },
        title: { type: 'string' }
      }
    },
    handler: {
      apply: ({ command }) => {
        const id = terminalIdOf(command.target)
        const p = command.payload ?? {}







        const saved = snapshots.get(id)
        const cwd = preferredTerminalCwd({
          requested: p.cwd,
          saved: saved?.cwd,
          workspace: defaultCwd()
        })
        const result = terminals.spawn(id, p.cols, p.rows, cwd, p.title)


        if (!result.ok) throw new CommandError('failed', result.error ?? 'failed to start the terminal')
        if (result.reconnected) {
          return { ok: true, live: true, scrollback: terminals.fullOutput(id) ?? '' }
        }
        if (saved?.title && saved.title !== id && !isDefaultTerminalTitle(saved.title)) {
          terminals.setTitle(id, saved.title, { unique: true })
        }
        if (typeof saved?.lastPrompt === 'string') terminals.rememberPrompt(id, saved.lastPrompt)
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
          // Only the empty/`new` placeholder may float to another shell.
          // An explicit dead id stays as-is so the wait below fails with
          // `not_found` ({ requested, resolved }) instead of typing into the
          // wrong terminal. resolveWriteTarget logs what it decided.
          const resolved = terminals.resolveWriteTarget(id)
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
            if (command.payload?.pressEnter !== false) terminals.rememberPrompt(id, singleLine)
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
          if (command.payload?.pressEnter !== false) terminals.rememberPrompt(id, singleLine)


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














  flow.registerDefinition<
    {
      image?: string
      images?: string[]
      text?: string
      pressEnter?: boolean
      confirmDelivery?: boolean
      deliveryTimeoutMs?: number
    },
    { ok: true; id: string; mode: AttachmentMode; images: string[]; agent?: string; text?: string }
  >({
    type: 'terminal.attach',
    description:
      'Hand image files to whatever agent is running in a terminal — pasted through the clipboard when its TUI supports it, typed as paths when it does not — then optionally type a line of text.',
    targetScheme: 'terminal',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Absolute path to an image file' },
        images: { type: 'array', items: { type: 'string' }, description: 'Several images at once' },
        text: { type: 'string', description: 'Line typed after the images' },
        pressEnter: { type: 'boolean', description: 'Submit after typing (default true when there is text)' },
        confirmDelivery: { type: 'boolean', description: 'Wait for the text to echo in the target terminal' },
        deliveryTimeoutMs: { type: 'number', description: 'Receipt timeout in milliseconds' }
      }
    },
    handler: {
      apply: async ({ command, unblock, signal }) => {
        let id = terminalIdOf(command.target)
        if (!terminals.isRunning(id)) {
          const resolved = terminals.resolveWriteTarget(id)
          if (resolved) id = resolved
        }
        const p = command.payload ?? {}
        const sources = [...(Array.isArray(p.images) ? p.images : []), p.image]
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0)
        if (sources.length === 0) {
          throw new CommandError('invalid', 'terminal.attach needs payload.image or payload.images')
        }
        let files: MediaFile[]
        try {
          files = sources.map((source) => resolveImage(source))
        } catch (err) {
          throw new CommandError('invalid', err instanceof Error ? err.message : String(err))
        }

        const resource = `terminal:${id}`
        if (core.locks.isLockedByOther(resource, command.actorId)) {
          const lock = core.locks.holder(resource)
          throw new CommandError('locked', `${resource} is locked by ${lock?.actorId}`, { lock })
        }
        let extraLock = false
        if (!core.locks.isHeldBy(resource, command.actorId)) {
          core.locks.acquire({ resource, actorId: command.actorId, reason: 'terminal.attach', implicit: true })
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

          const agent = terminalAgent({ terminals, orchestration }, id)
          const shortcut = imagePasteShortcut(agent, process.platform)
          let mode = attachmentMode(files.length, shortcut)

          if (mode === 'clipboard' && shortcut) {
            const staged = await stageClipboardImage(readFileSync(files[0].path))
            if ('ok' in staged) {
              const written = await terminals.writeInput(id, shortcut)
              if (!written.ok) throw new CommandError('failed', written.error)
              await settle(IMAGE_PASTE_SETTLE_MS, signal)
            } else {

              mode = 'path'
            }
          }
          if (mode === 'path') {
            for (const file of files) {
              const written = await terminals.writeInput(id, pathToken(file.path))
              if (!written.ok) throw new CommandError('failed', written.error)
            }
          }

          const text = typeof p.text === 'string' ? p.text.replace(/\r\n|\r|\n/g, ' ').trim() : ''
          const pressEnter = p.pressEnter === undefined ? text.length > 0 : p.pressEnter !== false
          if (text) {
            if (p.confirmDelivery === true) {
              const receipt = await terminals.deliverLine(id, text, {
                pressEnter,
                timeoutMs: p.deliveryTimeoutMs,
                signal
              })
              if (!receipt.ok) {
                throw new CommandError('failed', receipt.error, { terminalId: receipt.terminalId, status: 'not_sent' })
              }
            } else {
              const written = await terminals.writeLine(id, text, { pressEnter, signal })
              if (!written.ok) throw new CommandError('failed', written.error)
            }
            if (pressEnter) terminals.rememberPrompt(id, text)
          } else if (pressEnter) {
            const written = await terminals.writeInput(id, '\r')
            if (!written.ok) throw new CommandError('failed', written.error)
          }

          return {
            ok: true as const,
            id,
            mode,
            images: files.map((file) => file.path),
            ...(agent ? { agent } : {}),
            ...(text ? { text } : {})
          }
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
    // The person at the keyboard is not a participant in agent coordination.
    // Without this, every keystroke was rejected with `locked` while any
    // actor held `terminal:<id>` — which `terminal.write` takes for the whole
    // of its delivery (up to an 8s wait for the shell, plus a 4s echo
    // confirmation), and which lingers for its 30s TTL if a release is ever
    // missed. Typing was silently dropped and Ctrl+C could not get through,
    // so a terminal that was merely busy looked permanently hung and closing
    // the widget was the only way out. Same reasoning as `terminal.resize`.
    requiresLock: false,
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
