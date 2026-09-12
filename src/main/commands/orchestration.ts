import { CommandError, parseResource, type CommandPayloadSchema } from '../core/index.ts'
import { buildPreamble, dispatchSummary } from '../orchestration/preamble.ts'
import { MESSAGE_TYPES, OUTCOMES, TASK_STATUSES, type MessageType, type Outcome } from '../orchestration/types.ts'
import { resolveRecipient, resolveWorker } from '../orchestration/workers.ts'
import type { CommandDeps } from './index.ts'

function idOf(target: string, scheme: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== scheme) throw new CommandError('invalid', `${target} is not a ${scheme}`)
  return parsed.id
}

const STRING_LIST: CommandPayloadSchema['properties'][string] = {
  type: 'array',
  items: { type: 'string' }
}










export function registerOrchestrationCommands(deps: CommandDeps): void {
  const { core, orchestration, terminals, requestWidget, requestWidgetRemoval, originWidgetId, defaultCwd } = deps
  const { flow } = core

  flow.registerVersions('run', orchestration.runVersions)
  flow.registerVersions('orctask', orchestration.taskVersions)
  flow.registerVersions('dispatch', orchestration.dispatchVersions)
  flow.registerVersions('gate', orchestration.gateVersions)



  flow.registerDefinition<{ objective?: string }, ReturnType<typeof orchestration.createRun>>({
    type: 'run.create',
    description: 'Open an orchestration run: a namespace for tasks and the coordinator inbox workers report into.',
    targetScheme: 'run',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['objective'],
      properties: { objective: { type: 'string', description: 'What this fleet of agents is collectively for' } }
    },
    handler: {
      apply: ({ command, actor }) =>
        orchestration.createRun({ objective: String(command.payload?.objective ?? ''), coordinator: actor.id })
    }
  })

  flow.registerDefinition<Record<string, never>, ReturnType<typeof orchestration.closeRun>>({
    type: 'run.close',
    description: 'Close a run. Its tasks and mail stay readable.',
    targetScheme: 'run',
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: {} },
    handler: { apply: ({ command }) => orchestration.closeRun(idOf(command.target, 'run')) }
  })



  flow.registerDefinition<
    { runId?: string; title?: string; spec?: string; deps?: string[]; images?: string[] },
    ReturnType<typeof orchestration.createTask>
  >({
    type: 'orctask.create',
    description:
      'File a unit of delegated work. `deps` are task ids that must complete first — that is how a DAG is built.',
    targetScheme: 'orctask',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['spec'],
      properties: {
        runId: { type: 'string', description: 'Run to file under; defaults to the newest open run' },
        title: { type: 'string', description: 'Short label for the UI; defaults to the spec’s first line' },
        spec: { type: 'string', description: 'The brief handed to the worker verbatim' },
        deps: { ...STRING_LIST, description: 'Task ids that must reach completed before this becomes ready' },
        images: { ...STRING_LIST, description: 'Image files the worker should look at; paths reach it in the preamble' }
      }
    },
    handler: {
      apply: ({ command, actor }) => {
        const p = command.payload ?? {}
        return orchestration.createTask({
          runId: resolveRunId(p.runId),
          title: p.title,
          spec: String(p.spec ?? ''),
          deps: p.deps,
          images: p.images,
          createdBy: actor.id
        })
      }
    }
  })

  flow.registerDefinition<
    { status?: (typeof TASK_STATUSES)[number]; title?: string; spec?: string },
    ReturnType<typeof orchestration.updateTask>
  >({
    type: 'orctask.update',
    description: 'Change a task’s status, title or spec.',
    targetScheme: 'orctask',
    payloadSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...TASK_STATUSES] },
        title: { type: 'string' },
        spec: { type: 'string' }
      }
    },
    handler: {
      apply: ({ command }) => orchestration.updateTask(idOf(command.target, 'orctask'), command.payload ?? {})
    }
  })









  flow.registerDefinition<
    { taskId?: string; terminalId?: string; agent?: string; command?: string; inject?: boolean },
    { dispatchId: string; taskId: string; terminalId: string; agent: string; injected: boolean }
  >({
    type: 'dispatch.start',
    description:
      'Dispatch a task onto a worker terminal. Opens a new terminal unless `terminalId` names an existing one, then injects the worker preamble.',
    targetScheme: 'dispatch',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'Task to hand over' },
        terminalId: { type: 'string', description: 'Existing terminal to dispatch into; omit to open a fresh one' },
        agent: { type: 'string', description: 'CLI to start in a fresh terminal: claude | codex | opencode | antigravity | grok | gemini | cursor | aider' },
        command: { type: 'string', description: 'Override the command used to start the agent' },
        inject: { type: 'boolean', description: 'false records the dispatch without typing the preamble' }
      }
    },
    handler: {
      apply: async ({ command, actor, unblock, signal }) => {
        const p = command.payload ?? {}
        const task = orchestration.requireTask(String(p.taskId ?? ''))
        const run = orchestration.requireRun(task.runId)
        const agent = String(p.agent ?? 'claude')
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(agent)) {
          throw new CommandError('invalid', 'agent must be 1–64 chars of [A-Za-z0-9_.-]')
        }
        const conflicting = orchestration.listDispatches({ taskId: task.id }).find((d) => d.state === 'running')
        if (conflicting) {
          throw new CommandError('conflict', `task "${task.id}" already has a running dispatch`, {
            dispatchId: conflicting.id,
            terminalId: conflicting.terminalId
          })
        }

        let terminalId = String(p.terminalId ?? '').trim()
        let opened = false
        if (terminalId) {


          terminalId = resolveWorker({ terminals, orchestration }, terminalId, actor.id).id
          const busy = orchestration.dispatchForTerminal(terminalId)
          if (busy) {
            throw new CommandError('conflict', `terminal "${terminalId}" is already running dispatch ${busy.id}`)
          }
        } else {
          const info = terminals.reserve({ title: `${agent}: ${task.title}`, cwd: defaultCwd(), prefix: 'agent' })
          terminalId = info.id
          opened = true
          requestWidget({ id: info.id, title: info.title, from: originWidgetId() })



          unblock()
          const ready = await terminals.waitUntilRunning(info.id, 10_000, signal)
          if (!ready) {
            terminals.dispose(info.id)
            requestWidgetRemoval(info.id)
            throw new CommandError('failed', 'the OrcSpace window did not open a terminal for this dispatch', {
              id: info.id
            })
          }
        }

        const cleanupOpened = (): void => {
          if (!opened) return
          try {
            terminals.dispose(terminalId)
          } catch {

          }
          try {
            requestWidgetRemoval(terminalId)
          } catch {

          }
          try {
            deps.forgetOrigin(terminalId)
          } catch {

          }
        }

        let dispatch
        try {
          dispatch = orchestration.createDispatch({
            taskId: task.id,
            terminalId,
            agent,
            preamble: ''
          })
        } catch (err) {
          cleanupOpened()
          throw err
        }
        const preamble = buildPreamble({ run, task, dispatchId: dispatch.id, agent })
        dispatch.preamble = preamble

        try {
          let injected = false
          if (p.inject !== false) {



            if (opened) {
              const start = String(p.command ?? agent)
              if (!await submitPtyLine(terminals, terminalId, start, signal)) {
                throw new CommandError('failed', `could not start ${start} in terminal ${terminalId}`)
              }
              await delay(2_500, signal)
            }
            injected = await submitPtyLine(terminals, terminalId, preamble, signal)
          }

          orchestration.send({
            runId: run.id,
            type: 'dispatch',
            from: actor.id,
            to: terminalId,
            subject: `dispatch ${task.id}`,
            body: dispatchSummary(dispatch, task),
            taskId: task.id,
            dispatchId: dispatch.id
          })

          return { dispatchId: dispatch.id, taskId: task.id, terminalId, agent, injected }
        } catch (err) {
          try {
            orchestration.settleDispatch(dispatch.id, 'failed')
          } catch {

          }
          cleanupOpened()
          throw err
        }
      }
    }
  })

  flow.registerDefinition<
    { outcome?: Outcome; filesModified?: string[] },
    { dispatchId: string; taskId: string; status: string; promoted: string[] }
  >({
    type: 'dispatch.settle',
    description: 'Settle a dispatch with an outcome. Completes or fails its task and promotes whatever that unblocks.',
    targetScheme: 'dispatch',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['outcome'],
      properties: {
        outcome: { type: 'string', enum: [...OUTCOMES] },
        filesModified: { ...STRING_LIST, description: 'Paths the worker touched' }
      }
    },
    handler: {
      apply: ({ command }) => {
        const p = command.payload ?? {}
        const outcome = p.outcome
        if (!outcome || !OUTCOMES.includes(outcome)) {
          throw new CommandError('invalid', `outcome must be one of ${OUTCOMES.join(', ')}`)
        }
        const settled = orchestration.settleDispatch(idOf(command.target, 'dispatch'), outcome, p.filesModified)
        return {
          dispatchId: settled.dispatch.id,
          taskId: settled.task.id,
          status: settled.task.status,
          promoted: settled.promoted
        }
      }
    }
  })

  flow.registerDefinition<{ state?: 'retained' | 'released'; closeTerminal?: boolean }, { id: string; state: string }>({
    type: 'dispatch.account',
    description:
      'Account for a settled worker: `retained` keeps its terminal for debugging, `released` hands it back (and may close it).',
    targetScheme: 'dispatch',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['state'],
      properties: {
        state: { type: 'string', enum: ['retained', 'released'] },
        closeTerminal: { type: 'boolean', description: 'released only: also close the terminal widget' }
      }
    },
    handler: {
      apply: ({ command }) => {
        const p = command.payload ?? {}
        const state = p.state
        if (state !== 'retained' && state !== 'released') {
          throw new CommandError('invalid', 'state must be retained|released')
        }
        const dispatch = orchestration.setDispatchState(idOf(command.target, 'dispatch'), state)
        if (state === 'released' && p.closeTerminal) {
          terminals.dispose(dispatch.terminalId)
          deps.requestWidgetRemoval(dispatch.terminalId)
          deps.forgetOrigin(dispatch.terminalId)
        }
        return { id: dispatch.id, state: dispatch.state }
      }
    }
  })



  flow.registerDefinition<
    {
      runId?: string
      type?: MessageType
      to?: string
      subject?: string
      body?: string
      taskId?: string
      dispatchId?: string
      outcome?: Outcome
      filesModified?: string[]
      images?: string[]
      options?: string[]
      replyTo?: string
    },
    { id: string; type: string; to: string; settled?: { taskId: string; status: string; promoted: string[] } }
  >({
    type: 'orc.send',
    description:
      'Put a message in the run inbox. A `worker_done` also settles its dispatch, which is what a coordinator’s `check --wait` is blocked on.',
    targetScheme: 'run',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['type'],
      properties: {
        runId: { type: 'string', description: 'Defaults to the newest open run' },
        type: { type: 'string', enum: [...MESSAGE_TYPES] },
        to: { type: 'string', description: 'Actor id, or @all | @idle | @coordinator | @<agent>' },
        subject: { type: 'string' },
        body: { type: 'string' },
        taskId: { type: 'string' },
        dispatchId: { type: 'string', description: 'Required on worker_done — it is the authority to settle' },
        outcome: { type: 'string', enum: [...OUTCOMES], description: 'worker_done only' },
        filesModified: STRING_LIST,
        images: { ...STRING_LIST, description: 'Image files attached to the message; the reader opens them by path' },
        options: { ...STRING_LIST, description: 'ask only: the choices offered' },
        replyTo: { type: 'string', description: 'reply only: the ask being answered' }
      }
    },
    handler: {
      apply: ({ command, actor }) => {
        const p = command.payload ?? {}
        const type = p.type
        if (!type || !MESSAGE_TYPES.includes(type)) {
          throw new CommandError('invalid', `type must be one of ${MESSAGE_TYPES.join(', ')}`)
        }
        const runId = resolveRunId(p.runId)
        const to = resolveRecipient(
          { terminals, orchestration, knownActor: (id) => !!core.actors.get(id) },
          p.to,
          actor.id
        )




        let settled: { taskId: string; status: string; promoted: string[] } | undefined
        if (type === 'worker_done') {
          const dispatchId = String(p.dispatchId ?? '')
          if (!dispatchId) {
            throw new CommandError('invalid', 'worker_done needs --dispatch-id (it is in your dispatch preamble)')
          }
          const outcome = p.outcome
          if (!outcome || !OUTCOMES.includes(outcome)) {
            throw new CommandError('invalid', 'worker_done needs --outcome succeeded|failed')
          }
          const result = orchestration.settleDispatch(dispatchId, outcome, p.filesModified)
          settled = { taskId: result.task.id, status: result.task.status, promoted: result.promoted }
        }

        const message = orchestration.send({
          runId,
          type,
          from: actor.id,


          to,
          subject: p.subject,
          body: p.body,
          taskId: p.taskId,
          dispatchId: p.dispatchId,
          outcome: p.outcome,
          filesModified: p.filesModified,
          images: p.images,
          options: p.options,
          replyTo: p.replyTo
        })
        return {
          id: message.id,
          type: message.type,
          from: message.from,
          to: message.to,
          subject: message.subject,
          body: message.body,
          ...(message.images?.length ? { images: message.images } : {}),
          taskId: message.taskId,
          dispatchId: message.dispatchId,
          replyTo: message.replyTo,
          ...(settled ? { settled } : {})
        }
      }
    }
  })

  flow.registerDefinition<{ messageId?: string }, { id: string }>({
    type: 'orc.ack',
    description: 'Consume a message so the next `check` moves past it.',
    targetScheme: 'run',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['messageId'],
      properties: { messageId: { type: 'string' } }
    },
    handler: {
      apply: ({ command, actor }) => {
        const message = orchestration.ack(String(command.payload?.messageId ?? ''), actor.id)
        return { id: message.id }
      }
    }
  })



  flow.registerDefinition<
    { runId?: string; taskId?: string; question?: string; options?: string[] },
    ReturnType<typeof orchestration.createGate>
  >({
    type: 'gate.create',
    description: 'Open a decision gate: a blocking question that stops its task until someone resolves it.',
    targetScheme: 'gate',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        runId: { type: 'string' },
        taskId: { type: 'string', description: 'Task to block while the gate is open' },
        question: { type: 'string' },
        options: { ...STRING_LIST, description: 'Allowed resolutions; empty means free text' }
      }
    },
    handler: {
      apply: ({ command, actor }) => {
        const p = command.payload ?? {}
        return orchestration.createGate({
          runId: resolveRunId(p.runId),
          taskId: p.taskId,
          question: String(p.question ?? ''),
          options: p.options,
          createdBy: actor.id
        })
      }
    }
  })

  flow.registerDefinition<{ resolution?: string }, ReturnType<typeof orchestration.resolveGate>>({
    type: 'gate.resolve',
    description: 'Answer a decision gate and unblock its task.',
    targetScheme: 'gate',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['resolution'],
      properties: { resolution: { type: 'string' } }
    },
    handler: {
      apply: ({ command }) =>
        orchestration.resolveGate(idOf(command.target, 'gate'), String(command.payload?.resolution ?? ''))
    }
  })


  function resolveRunId(explicit?: string): string {
    if (explicit) return orchestration.requireRun(explicit).id
    const active = orchestration.activeRun()
    if (!active) throw new CommandError('not_found', 'no open run — call `orc run-create --objective "..."` first')
    return active.id
  }
}

export function failTerminalDispatches(deps: Pick<CommandDeps, 'orchestration'>, terminalId: string): void {
  const running = deps.orchestration.listDispatches({ terminalId }).filter((d) => d.state === 'running')
  for (const dispatch of running) {
    try {
      deps.orchestration.settleDispatch(dispatch.id, 'failed')
    } catch {

    }
  }
}

const PTY_CHUNK_CHARS = 8000

async function submitPtyLine(
  terminals: CommandDeps['terminals'],
  terminalId: string,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  const singleLine = text.replace(/\r\n|\r|\n/g, ' ')
  if (singleLine.length <= PTY_CHUNK_CHARS) {
    return (await terminals.writeLine(terminalId, singleLine, { signal })).ok
  }
  for (let i = 0; i < singleLine.length; i += PTY_CHUNK_CHARS) {
    if (signal?.aborted) return false
    const last = i + PTY_CHUNK_CHARS >= singleLine.length
    const ok = (
      await terminals.writeLine(terminalId, singleLine.slice(i, i + PTY_CHUNK_CHARS), {
        pressEnter: last,
        signal
      })
    ).ok
    if (!ok) return false
  }
  return true
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
