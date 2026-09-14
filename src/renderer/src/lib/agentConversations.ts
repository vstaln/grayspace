/**
 * Helpers for the Resume panel in Code: how a conversation's age reads, and
 * which conversations the user has already waved away for a folder.
 */

export interface AgentConversation {
  id: string
  agentId: 'claude' | 'codex' | 'antigravity'
  title: string
  updatedAt: number
  command: string
}

/** One key per folder, so dismissing here never hides another project's work. */
export function dismissedKey(dir: string): string {
  return `orcspace:code-resume-dismissed:${dir}`
}

export function conversationKey(conversation: Pick<AgentConversation, 'agentId' | 'id'>): string {
  return `${conversation.agentId}:${conversation.id}`
}

interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function store(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Storage can be blocked outright; the panel simply forgets dismissals.
    return null
  }
}

export function readDismissed(dir: string, storage: KeyValueStore | null = store()): Set<string> {
  if (!dir || !storage) return new Set()
  try {
    const raw = storage.getItem(dismissedKey(dir))
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Persists the dismissals that still match a live conversation. Pruning on
 * every write is what keeps the key from growing without bound as agents
 * create and delete transcripts.
 */
export function writeDismissed(
  dir: string,
  dismissed: Iterable<string>,
  live: Iterable<string>,
  storage: KeyValueStore | null = store()
): string[] {
  const liveKeys = new Set(live)
  const kept = Array.from(new Set(dismissed)).filter((key) => liveKeys.has(key))
  if (!dir || !storage) return kept
  try {
    if (kept.length === 0) storage.removeItem(dismissedKey(dir))
    else storage.setItem(dismissedKey(dir), JSON.stringify(kept))
  } catch {
    // A full or blocked store must not break dismissing.
  }
  return kept
}

/**
 * Rows the panel should show: everything not dismissed, newest first. The
 * order comes from the scan, so this only removes — re-sorting here would
 * fight whatever ranking the store applied.
 */
export function visibleConversations<T extends Pick<AgentConversation, 'agentId' | 'id'>>(
  conversations: readonly T[],
  dismissed: ReadonlySet<string>
): T[] {
  return conversations.filter((conversation) => !dismissed.has(conversationKey(conversation)))
}

/**
 * How many "Resume all" may open at once: never more than there are rows,
 * free session slots, or the bulk cap that keeps one click from starting a
 * dozen CLI processes.
 */
export function resumeAllCount(visible: number, remainingSlots: number, max: number): number {
  return Math.max(0, Math.min(visible, remainingSlots, max))
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "24 minutes ago" — short enough for a row, precise enough to recognise. */
export function relativeTime(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return 'unknown'
  const delta = now - at
  // A clock that jumped, or a file written a moment ahead of us.
  if (delta < MINUTE) return 'just now'
  const plural = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? '' : 's'} ago`
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), 'minute')
  if (delta < DAY) return plural(Math.floor(delta / HOUR), 'hour')
  if (delta < 30 * DAY) return plural(Math.floor(delta / DAY), 'day')
  try {
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return plural(Math.floor(delta / DAY), 'day')
  }
}

/**
 * Selects conversations suitable for automatic resumption when entering a workspace.
 *
 * It prioritises the newest conversation for each distinct agent, plus conversations
 * from the same recent burst of work (within 2 hours of the newest conversation),
 * capped at the available slots.
 */
export function selectAutoResumeConversations<T extends Pick<AgentConversation, 'agentId' | 'id' | 'updatedAt'>>(
  conversations: readonly T[],
  maxSlots: number
): T[] {
  if (conversations.length === 0 || maxSlots <= 0) return []
  const latestTime = conversations[0].updatedAt
  const RECENT_BURST_MS = 2 * 60 * 60 * 1000 // 2 hours

  const selected: T[] = []
  const seenAgents = new Set<string>()

  for (const conv of conversations) {
    if (selected.length >= maxSlots) break
    const isNewAgent = !seenAgents.has(conv.agentId)
    const isRecentBurst = latestTime > 0 && latestTime - conv.updatedAt < RECENT_BURST_MS
    if (isNewAgent || isRecentBurst) {
      selected.push(conv)
      seenAgents.add(conv.agentId)
    }
  }

  return selected
}

/**
 * Returns true if the command already has resume flags for the given agent.
 */
export function isResumeCommand(command: string): boolean {
  if (!command) return false
  return /(?:^|\s)(?:--resume|--conversation)\b/i.test(command) || /\bcodex\s+resume\b/i.test(command)
}

/**
 * Extracts the conversation or session id from a resume command.
 */
export function extractResumeId(command: string): string | null {
  if (!command) return null
  const m1 = command.match(/(?:--resume|--conversation)\s+([^\s]+)/i)
  if (m1 && m1[1]) return m1[1]
  const m2 = command.match(/\bcodex\s+resume\s+([^\s]+)/i)
  if (m2 && m2[1]) return m2[1]
  return null
}

export interface UpgradableAgent {
  id: string
  command: string
  label: string
}

export interface UpgradableSession<A extends UpgradableAgent = UpgradableAgent> {
  id: string
  agent: A
  title?: string
  status?: 'active' | 'finished'
}

/**
 * Upgrades restored sessions to resume past conversations where applicable:
 * 1. Pre-reserves conversations already owned by existing resume-command sessions,
 *    preventing duplicate resumption of the same conversation.
 * 2. Uses agentId-scoped keys (conversationKey) so identical conversation IDs from
 *    different agents do not collide.
 * 3. Matches bare command sessions with remaining conversations for that agent.
 * 4. Ensures all restored agent sessions receive 'active' status so they run.
 */
export function upgradeSessionsToResume<A extends UpgradableAgent, T extends UpgradableSession<A>>(
  sessions: readonly T[],
  conversations: readonly AgentConversation[]
): { sessions: T[]; upgraded: boolean } {
  const used = new Set<string>()

  // Pass 1: Reserve conversations already referenced by sessions with resume commands
  for (const session of sessions) {
    if (session.agent.id === 'browser') continue
    if (!isResumeCommand(session.agent.command)) continue

    const resumeId = extractResumeId(session.agent.command)
    if (resumeId) {
      used.add(`${session.agent.id}:${resumeId}`)
    }

    const matchingConv = conversations.find(
      (c) =>
        c.agentId === session.agent.id &&
        (c.command.trim() === session.agent.command.trim() ||
          (resumeId !== null && c.id === resumeId) ||
          session.agent.command.includes(c.id))
    )
    if (matchingConv) {
      used.add(conversationKey(matchingConv))
    }
  }

  // Pass 2: Upgrade bare commands to the latest available conversation for each agent
  let upgraded = false
  const resultSessions: T[] = sessions.map((session) => {
    if (session.agent.id === 'browser') return session
    if (isResumeCommand(session.agent.command)) {
      return { ...session, status: 'active' }
    }

    const match = conversations.find(
      (c) => c.agentId === session.agent.id && !used.has(conversationKey(c))
    )
    if (match) {
      used.add(conversationKey(match))
      upgraded = true
      const title =
        session.title && session.title !== session.agent.label
          ? session.title
          : (match.title || session.title || session.agent.label)
      return {
        ...session,
        agent: { ...session.agent, command: match.command },
        title,
        status: 'active'
      }
    }

    return { ...session, status: 'active' }
  })

  return { sessions: resultSessions, upgraded }
}
