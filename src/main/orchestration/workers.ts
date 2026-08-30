import { CommandError } from '../core/index.ts'
import type { TerminalManager } from '../terminals.ts'
import type { OrchestrationStore } from './store.ts'

/** Group handles the store resolves itself; they are never worker names. */
export const GROUP_HANDLES = new Set(['@all', '@idle', '@coordinator'])

export interface WorkerInfo {
  /** The terminal id — the worker's actor id everywhere else in the system. */
  id: string
  /** Its visible title on the canvas, which is also how agents address it. */
  name: string
  /** The CLI running in it, when a dispatch says so. */
  agent?: string
  /** The dispatch it is currently serving, if any. */
  dispatchId?: string
  taskId?: string
  busy: boolean
  /** True for the terminal asking — so an agent can tell itself apart. */
  self: boolean
}

/**
 * Who else is on the canvas.
 *
 * This is what makes "tell the other Claude to do X" work at all: an agent
 * cannot address a sibling it has no name for, and terminal ids (`term-7`) are
 * not names a model will use correctly or a human will recognise. The visible
 * widget title is the handle, which means renaming a worker on the canvas and
 * renaming it from an agent are the same act with the same result.
 */
export function listWorkers(
  deps: { terminals: TerminalManager; orchestration: OrchestrationStore },
  callerId?: string
): WorkerInfo[] {
  const running = new Map<string, { id: string; agent: string; taskId: string }>()
  for (const dispatch of deps.orchestration.listDispatches()) {
    if (dispatch.state === 'running') {
      running.set(dispatch.terminalId, { id: dispatch.id, agent: dispatch.agent, taskId: dispatch.taskId })
    }
  }
  return deps.terminals.list().map((terminal) => {
    const live = running.get(terminal.id)
    return {
      id: terminal.id,
      name: terminal.title || terminal.id,
      ...(live ? { agent: live.agent, dispatchId: live.id, taskId: live.taskId } : {}),
      busy: !!live,
      self: terminal.id === callerId
    }
  })
}

/**
 * Turns whatever an agent typed into a terminal id.
 *
 * Accepts the id itself, the exact name, a case-insensitive name, a `@name`
 * handle, or an unambiguous prefix — because a model that was told a worker is
 * called "backend" will write `backend`, `@backend`, and `Backend` on
 * different turns, and all three mean the same terminal.
 *
 * Ambiguity is an error rather than a guess: silently picking one of two
 * workers called "claude" would send work to the wrong agent, and that failure
 * surfaces minutes later as a confusing diff rather than as a message here.
 */
export function resolveWorker(
  deps: { terminals: TerminalManager; orchestration: OrchestrationStore },
  raw: string,
  callerId?: string
): WorkerInfo {
  const wanted = String(raw ?? '').trim().replace(/^@/, '')
  if (!wanted) throw new CommandError('invalid', 'a worker name or terminal id is required')

  const workers = listWorkers(deps, callerId)
  if (wanted === 'self' || wanted === 'me') {
    const self = workers.find((w) => w.self)
    if (!self) throw new CommandError('not_found', 'this shell is not an OrcSpace terminal')
    return self
  }

  if (wanted === 'other' || wanted === 'neighbor' || wanted === 'сосед' || wanted === 'peer') {
    const others = workers.filter((w) => !w.self)
    if (others.length === 1) return others[0]
    if (others.length === 0) throw new CommandError('not_found', 'no other terminals are open on the canvas')
    const known = others.map((w) => `${w.name} (${w.id})`).join(', ')
    throw new CommandError('invalid', `several other terminals are open: ${known} — specify one by name or id`)
  }

  const byId = workers.find((w) => w.id === wanted)
  if (byId) return byId

  let exact = workers.filter((w) => w.name === wanted)
  if (exact.length > 1 && callerId) {
    const nonSelf = exact.filter((w) => !w.self)
    if (nonSelf.length === 1) exact = nonSelf
  }
  if (exact.length === 1) return exact[0]

  const lower = wanted.toLowerCase()
  let insensitive = workers.filter((w) => w.name.toLowerCase() === lower)
  if (insensitive.length > 1 && callerId) {
    const nonSelf = insensitive.filter((w) => !w.self)
    if (nonSelf.length === 1) insensitive = nonSelf
  }
  if (insensitive.length === 1) return insensitive[0]

  let prefixed = workers.filter((w) => w.name.toLowerCase().startsWith(lower))
  if (prefixed.length > 1 && callerId) {
    const nonSelf = prefixed.filter((w) => !w.self)
    if (nonSelf.length === 1) prefixed = nonSelf
  }
  if (prefixed.length === 1) return prefixed[0]

  const candidates = (exact.length ? exact : insensitive.length ? insensitive : prefixed).map((w) => `${w.name} (${w.id})`)
  if (candidates.length > 1) {
    throw new CommandError('invalid', `"${raw}" matches several workers: ${candidates.join(', ')} — use the terminal id`)
  }
  const known = workers.map((w) => w.name).join(', ') || '(none open)'
  throw new CommandError('not_found', `no worker called "${raw}" — open workers: ${known}`)
}

/**
 * Resolves a message recipient.
 *
 * Group handles pass through untouched. A name is resolved against the open
 * workers so a typo fails at send time rather than becoming mail nobody is
 * addressed by. But resolution is not the *only* way to be a valid recipient:
 * an actor the core already knows is addressable even with no terminal behind
 * it — a coordinator that is not a shell, or a worker whose terminal has since
 * been closed. Requiring a live terminal there meant a worker that asked a
 * question and then lost its pane could never be answered, and its `ask`
 * blocked until the timeout with no way to rescue it.
 */
export function resolveRecipient(
  deps: {
    terminals: TerminalManager
    orchestration: OrchestrationStore
    /** True for an actor the core has seen, terminal or not. */
    knownActor?(id: string): boolean
  },
  to: string | undefined,
  callerId?: string
): string {
  const wanted = String(to ?? '').trim()
  if (!wanted) return '@coordinator'
  if (GROUP_HANDLES.has(wanted)) return wanted
  // `@claude` / `@codex` address every worker running that CLI — a real group,
  // and deliberately checked before names so a worker *named* "claude" cannot
  // shadow it.
  if (wanted.startsWith('@') && isAgentHandle(deps, wanted.slice(1))) return wanted
  try {
    return resolveWorker(deps, wanted, callerId).id
  } catch (err) {
    if (deps.knownActor?.(wanted)) return wanted
    throw err
  }
}

function isAgentHandle(deps: { orchestration: OrchestrationStore }, agent: string): boolean {
  return deps.orchestration.listDispatches().some((d) => d.agent === agent && d.state === 'running')
}
