// Explicit extension: this module is loaded both by Vite and directly by the
// node test runner, and node's ESM resolver does not infer it.
import { capOldest } from './boundedCache.ts'

/**
 * Commands queued to be typed into a terminal the first time it comes up
 * (the agent CLI chosen in the launcher, for instance).
 *
 * An entry means "this has not been typed yet", and it stays queued until it
 * actually reaches the pty. That distinction is the whole point: the queue
 * used to be consumed the moment a widget started connecting, and the write
 * happened on a short timer afterwards, so a widget torn down in between —
 * which is routine, because closing one code session re-lays-out and remounts
 * its neighbours — destroyed the command without ever running it. The next
 * generation of that widget then re-attached to an already-running shell,
 * found nothing queued, and the terminal sat at a bare prompt with the agent
 * never started.
 */

const pending = new Map<string, string>()

/**
 * Terminals whose queued command has been typed. Callers re-queue on every
 * state broadcast (they cannot tell a restored session from a running one),
 * and without this the command would be typed a second time on the next
 * remount — now that delivery, not connection, is what clears the entry.
 */
const delivered = new Set<string>()

/**
 * An entry is normally consumed the moment its terminal comes up, but a queued
 * command whose widget never appears (spawn refused, widget removed first) has
 * nothing to consume it. Capping keeps that from accumulating over a long
 * session; the oldest entry is the one least likely to still be wanted.
 */
const MAX_PENDING_COMMANDS = 200
const MAX_DELIVERED_IDS = 500

/**
 * Queue a command the user just asked for. Always queues, including for a
 * terminal that has already run one — launching a different agent, or
 * retrying a launch the pty was not ready for, is a new request.
 */
export function queueInitialCommand(id: string, command: string): void {
  pending.set(id, command)
  capOldest(pending, MAX_PENDING_COMMANDS)
}

/**
 * Queue only if this terminal has not already run its command.
 *
 * For callers that re-queue in bulk from persisted state and cannot tell a
 * session restored from disk (needs its command) from one already running
 * (does not). Delivery, not connection, clears an entry now, so without this
 * the next remount of a running session would type the agent command a second
 * time into the agent already sitting there.
 */
export function queueInitialCommandOnce(id: string, command: string): void {
  if (delivered.has(id)) return
  queueInitialCommand(id, command)
}

/** Read without consuming — the caller has not delivered anything yet. */
export function peekInitialCommand(id: string): string | undefined {
  return pending.get(id)
}

/** The command reached the pty: drop it, and refuse to queue it again. */
export function markInitialCommandDelivered(id: string): void {
  pending.delete(id)
  delivered.add(id)
  capOldest(delivered, MAX_DELIVERED_IDS)
}

export function takeInitialCommand(id: string): string | undefined {
  const command = pending.get(id)
  if (command !== undefined) pending.delete(id)
  return command
}

/** The terminal is gone for good; nothing should ever be typed into it. */
export function clearInitialCommand(id: string): void {
  pending.delete(id)
  delivered.delete(id)
}
