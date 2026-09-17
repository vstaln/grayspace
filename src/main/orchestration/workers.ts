import { CommandError } from '../core/index.ts'
import type { TerminalManager } from '../terminals.ts'
import type { OrchestrationStore } from './store.ts'


export const GROUP_HANDLES = new Set(['@all', '@idle', '@coordinator'])

export interface WorkerInfo {

  id: string

  name: string

  agent?: string

  dispatchId?: string
  taskId?: string

  taskTitle?: string
  busy: boolean

  self: boolean

  cwd?: string

  alive?: boolean





  running?: string

  lastActiveAt?: number
}










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








export function detectRunning(title: string, tail: string | null): string | undefined {
  const fromTitle = /^\s*([A-Za-z][A-Za-z0-9_+-]*)\s*:/.exec(title ?? '')
  if (fromTitle && KNOWN_TOOLS.has(fromTitle[1].toLowerCase())) return `~${fromTitle[1].toLowerCase()}`
  if (!tail) return undefined
  const text = tail
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ')
    // Same linear-matching rule as normalizeDeliveryText in terminalDelivery.ts: the
    // body must not be able to swallow a following OSC introducer, or a tail
    // full of unterminated ESC] pairs (what `cat` on a binary leaves behind)
    // makes this quadratic. Bounded to 4KB here rather than 50KB, so it was
    // milliseconds rather than seconds — but it runs once per terminal on
    // every worker listing, and the safe pattern costs nothing.
    .replace(/\x1b\][^\x07\x9c\x1b]*(?:\x07|\x9c|\x1b\\)?/g, ' ')
    .toLowerCase()
  for (const tool of TAIL_TOOLS) {
    if (tool.pattern.test(text)) return `~${tool.name}`
  }
  return undefined
}


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







const TAIL_TOOLS = ['antigravity', 'claude', 'codex', 'gemini', 'opencode', 'windsurf', 'copilot', 'aider'].map(
  (name) => ({ name, pattern: new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`) })
)













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













export function resolveRecipient(
  deps: {
    terminals: TerminalManager
    orchestration: OrchestrationStore

    knownActor?(id: string): boolean
  },
  to: string | undefined,
  callerId?: string
): string {
  const wanted = String(to ?? '').trim()
  if (!wanted) return '@coordinator'
  if (GROUP_HANDLES.has(wanted)) return wanted



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
