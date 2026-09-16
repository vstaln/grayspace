/**
 * Whether a widget that just connected still owes its queued agent command.
 *
 * The queue deliberately survives a widget being torn down, because a widget
 * that died mid-connect leaves the shell running and its replacement always
 * arrives to `live: true` — throwing the command away there is what used to
 * leave code sessions sitting at a bare prompt with the agent never started.
 *
 * But "the pty was already running" covers a second case that must not be
 * typed into: the agent is *already up*. The renderer's record of what has
 * been delivered lives in this process only, so anything that reloads the
 * window (a restart of the UI while the main process keeps its ptys) starts
 * with an empty one, re-queues the command for every restored session, and
 * types `codex resume <id>` straight into the running codex — where it lands
 * in the agent's composer as literal text instead of starting anything.
 *
 * The terminal itself says which of the two it is. A shell at a prompt uses
 * the normal buffer and tracks no mouse; a full-screen application — every
 * agent TUI here, and anything else the user may have opened — switches to
 * the alternate buffer and turns mouse reporting on. Either on a live
 * re-attach means something already owns this terminal, and the command has
 * nothing left to do.
 *
 * Both signals reach the emulator through the replayed scrollback, so both
 * share its limit: the ring buffer is capped, and for a session that has been
 * running long enough for its history to rotate past the switch, neither is
 * visible any more and the command is typed as before. Mouse reporting
 * narrows that window a lot in practice — a TUI re-arms it on resize — but it
 * does not close it. Bracketed paste is deliberately *not* used: shells with
 * readline turn it on too, and a live shell at a prompt must still be typed
 * into.
 */
export interface InitialCommandContext {
  /** The pty was already running when this widget connected. */
  live: boolean
  /** xterm's active buffer, from `term.buffer.active.type`. */
  bufferType: 'normal' | 'alternate'
  /** xterm's mouse mode, from `term.modes.mouseTrackingMode`. */
  mouseTracking?: string
}

export type InitialCommandVerdict = 'type' | 'already-running'

export function initialCommandVerdict({
  live,
  bufferType,
  mouseTracking
}: InitialCommandContext): InitialCommandVerdict {
  // A fresh shell is typed into whatever its buffer says: replayed history
  // from a previous session can leave the emulator in the alternate buffer
  // even though the process underneath is brand new and owns none of it.
  if (!live) return 'type'
  if (bufferType === 'alternate') return 'already-running'
  const tracking = mouseTracking ?? 'none'
  return tracking !== 'none' ? 'already-running' : 'type'
}
