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
  /** Human title of the dispatched task, when there is one. */
  taskTitle?: string
  busy: boolean
  /** True for the terminal asking — so an agent can tell itself apart. */
  self: boolean
  /** Shell working directory, so agents can tell checkouts apart. */
  cwd?: string
  /** False when the shell process is gone but the widget is still listed. */
  alive?: boolean
  /**
   * What is running inside: the dispatch agent when there is one,
   * otherwise a best-effort guess from the title and recent output
   * (`~antigravity` — the `~` marks a guess, not a fact).
   */
  running?: string
  /** When the shell last printed anything, unix ms (0/undefined = never). */
  lastActiveAt?: number
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
  const titles = new Map<string, string>()
  try {
    for (const task of deps.orchestration.listTasks()) titles.set(task.id, task.title)
  } catch {
    /* a store that cannot list tasks simply yields no titles */
  }
  const terminals = deps.terminals as unknown as {
    list(): { id: string; title?: string; cwd?: string; alive?: boolean }[]
    tailOutput?(id: string, maxBytes?: number): string | null
    fullOutput?(id: string): string | null
    lastDataAt?(id: string): number
  }
  return terminals.list().map((terminal) => {
    const live = running.get(terminal.id)
    const title = terminal.title || terminal.id
    const taskTitle = live ? titles.get(live.taskId) : undefined
    let tail: string | null = null
    try {
      // Prefer the ring-buffer tail (no full join); fall back to a sliced
      // `fullOutput` so a fake/stub that only implements the wider getter
      // still feeds the detector.
      const tailed = terminals.tailOutput?.(terminal.id, 4_000)
      if (typeof tailed === 'string' && tailed.length > 0) {
        tail = tailed
      } else {
        const full = terminals.fullOutput?.(terminal.id)
        tail = typeof full === 'string' && full.length > 0 ? full.slice(-4_000) : null
      }
    } catch {
      tail = null
    }
    let lastActiveAt: number | undefined
    try {
      const at = terminals.lastDataAt?.(terminal.id)
      if (typeof at === 'number' && at > 0) lastActiveAt = at
    } catch {
      lastActiveAt = undefined
    }
    return {
      id: terminal.id,
      name: title,
      ...(live ? { agent: live.agent, dispatchId: live.id, taskId: live.taskId } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      busy: !!live,
      self: terminal.id === callerId,
      ...(typeof terminal.cwd === 'string' && terminal.cwd ? { cwd: terminal.cwd } : {}),
      ...(typeof terminal.alive === 'boolean' ? { alive: terminal.alive } : {}),
      running: live?.agent || detectRunning(title, tail) || 'shell',
      ...(lastActiveAt !== undefined ? { lastActiveAt } : {})
    }
  })
}

/**
 * Best-effort guess at which CLI owns a terminal nobody dispatched.
 *
 * A dispatched worker's agent is a fact recorded at dispatch time; anything
 * else is read off the title (`claude: …`) or the recent scrollback and
 * returned with a `~` prefix so callers can show it as uncertain.
 */
export function detectRunning(title: string, tail: string | null): string | undefined {
  const fromTitle = /^\s*([A-Za-z][A-Za-z0-9_+-]*)\s*:/.exec(title ?? '')
  if (fromTitle && KNOWN_TOOLS.has(fromTitle[1].toLowerCase())) return `~${fromTitle[1].toLowerCase()}`
  if (!tail) return undefined
  const text = tail
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ' ')
    .toLowerCase()
  for (const tool of TAIL_TOOLS) {
    if (tool.pattern.test(text)) return `~${tool.name}`
  }
  return undefined
}

/** CLI names worth recognising inside a shell. Order = match priority. */
const KNOWN_TOOLS_IN_ORDER = [
  'antigravity',
  'claude',
  'codex',
  'gemini',
  'opencode',
  'windsurf',
  'copilot',
  'aider',
  'cursor',
  'cline'
]
const KNOWN_TOOLS = new Set(KNOWN_TOOLS_IN_ORDER)

/**
 * Scrollback matching is deliberately narrower than title matching: a title
 * like `cursor: …` is a strong signal, but the bare words "cursor" ("cursor
 * position") or "cline" ("decline") appear in ordinary prose. So the tail
 * scan only looks for distinctive names, on word boundaries.
 */
const TAIL_TOOLS = ['antigravity', 'claude', 'codex', 'gemini', 'opencode', 'windsurf', 'copilot', 'aider'].map(
  (name) => ({ name, pattern: new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`) })
)

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
