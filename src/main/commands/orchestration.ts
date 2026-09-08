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

/**
 * Orchestration on the flow.
 *
 * Every dispatch, reply and completion is a command like any other, which is
 * the point: the journal ends up holding "agent-2 was told to do task X" right
 * next to the file writes agent-2 then made, and the locks an agent takes
 * while working are the same locks the board already understands. An
 * orchestration layer that kept its own side-channel would have neither.
 */
export function registerOrchestrationCommands(deps: CommandDeps): void {
  const { core, orchestration, terminals, requestWidget, originWidgetId, defaultCwd } = deps
  const { flow } = core

  flow.registerVersions('run', orchestration.runVersions)
  flow.registerVersions('orctask', orchestration.taskVersions)
  flow.registerVersions('dispatch', orchestration.dispatchVersions)
  flow.registerVersions('gate', orchestration.gateVersions)

  // ---- runs --------------------------------------------------------------

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

  // ---- tasks -------------------------------------------------------------

  flow.registerDefinition<
    { runId?: string; title?: string; spec?: string; deps?: string[] },
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
        deps: { ...STRING_LIST, description: 'Task ids that must reach completed before this becomes ready' }
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

  // ---- dispatch ----------------------------------------------------------

  /**
   * Starts a worker: opens (or reuses) a terminal, records the attempt, and
   * types the preamble into the shell. Everything the worker needs to report
   * back — its task id, its dispatch id, the exact commands — arrives in that
   * one injection, which is why nothing else has to be configured.
   */
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

        let terminalId = String(p.terminalId ?? '').trim()
        let opened = false
        if (terminalId) {
          // Accept a worker's visible name, not just its id — a coordinator
          // that just renamed a worker will address it by that name next.
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
          // The widget answers with `terminal.spawn`, which queues behind this
          // command; hand the queue on before waiting or every dispatch that
          // opens its own terminal deadlocks into a timeout.
          unblock()
          const ready = await terminals.waitUntilRunning(info.id, 10_000, signal)
          if (!ready) {
            terminals.dispose(info.id)
            throw new CommandError('failed', 'the OrcSpace window did not open a terminal for this dispatch', {
              id: info.id
            })
          }
        }

        // The dispatch id has to exist before the preamble is written, because
        // the preamble is what tells the worker its own dispatch id.
        const dispatch = orchestration.createDispatch({
          taskId: task.id,
          terminalId,
          agent,
          preamble: ''
        })
        const preamble = buildPreamble({ run, task, dispatchId: dispatch.id, agent })
        dispatch.preamble = preamble

        let injected = false
        if (p.inject !== false) {
          // A freshly opened terminal is a bare shell: start the CLI first, and
          // give it a moment to draw before typing into it. An existing
          // terminal is assumed to already have an agent waiting at a prompt.
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
        const state = p.state === 'retained' ? 'retained' : 'released'
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

  // ---- mail --------------------------------------------------------------

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

        // A completion report is not just mail: it is the event that settles
        // the attempt. Doing both here keeps them atomic — there is no window
        // where a coordinator has read "done" but the task still says running.
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
          // A name typed by an agent becomes a concrete terminal id here, so a
          // typo fails now rather than becoming mail nobody is addressed by.
          to: resolveRecipient(
            { terminals, orchestration, knownActor: (id) => !!core.actors.get(id) },
            p.to,
            actor.id
          ),
          subject: p.subject,
          body: p.body,
          taskId: p.taskId,
          dispatchId: p.dispatchId,
          outcome: p.outcome,
          filesModified: p.filesModified,
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

  // ---- decision gates ----------------------------------------------------

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

  /** Bare commands act on the newest open run so agents need not pass ids around. */
  function resolveRunId(explicit?: string): string {
    if (explicit) return orchestration.requireRun(explicit).id
    const active = orchestration.activeRun()
    if (!active) throw new CommandError('not_found', 'no open run — call `orc run-create --objective "..."` first')
    return active.id
  }
}

async function submitPtyLine(
  terminals: CommandDeps['terminals'],
  terminalId: string,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  const singleLine = text.replace(/\r\n|\r|\n/g, ' ')
  const typed = terminals.write(terminalId, singleLine)
  if (!typed.ok) return false
  await delay(30, signal)
  return terminals.write(terminalId, '\r').ok
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
