/**
 * Which saved terminals come back.
 *
 * Opening a folder used to relaunch every terminal it had when it was last
 * closed — a dozen agent CLIs starting at once, all of them costing a process
 * and some of them costing tokens, none of them asked for in this sitting.
 * The board now asks once per folder: tick the terminals worth bringing back,
 * and the rest are let go.
 */

export interface RestorableAgent {
  id: string
  label: string
  command: string
}

export interface RestorableSession<A extends RestorableAgent = RestorableAgent> {
  id: string
  agent: A
  title?: string
}

/**
 * A browser session opens a page, not a CLI, so it is not something the user
 * needs protecting from — it comes back with the board.
 */
export function startsAgent(session: RestorableSession): boolean {
  return session.agent.id !== 'browser' && Boolean(session.agent.command.trim())
}

/** Whether a restored board is worth asking about at all. */
export function needsRestorePrompt(sessions: readonly RestorableSession[]): boolean {
  return sessions.some(startsAgent)
}

/**
 * Splits a restored board into what to open and what to drop.
 *
 * Only the sessions that would start an agent are the user's to choose; the
 * rest ride along with whatever is kept, and are dropped only when the whole
 * board is.
 */
export function splitRestore<A extends RestorableAgent, T extends RestorableSession<A>>(
  sessions: readonly T[],
  chosen: ReadonlySet<string>
): { start: T[]; drop: T[] } {
  const keepsAny = sessions.some((session) => startsAgent(session) && chosen.has(session.id))
  const start: T[] = []
  const drop: T[] = []
  for (const session of sessions) {
    const wanted = startsAgent(session) ? chosen.has(session.id) : keepsAny
    ;(wanted ? start : drop).push(session)
  }
  return { start, drop }
}

/** Every session the prompt should offer, ticked to begin with. */
export function defaultChoice(sessions: readonly RestorableSession[]): Set<string> {
  return new Set(sessions.filter(startsAgent).map((session) => session.id))
}

/** "Michael · agy --conversation 9740…" — what a row says when it has no title. */
export function restoreRowTitle(session: RestorableSession): string {
  return session.title?.trim() || session.agent.label
}
