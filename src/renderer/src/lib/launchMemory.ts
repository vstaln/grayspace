/**
 * Whether the machine has the memory to start the sessions being asked for.
 *
 * An agent CLI is not a shell: a Bun/JSC one (opencode) measured ~1GB resident
 * per instance on Windows, and the others are in the same order of magnitude.
 * When several are launched at once past what the system can commit they do
 * not queue or degrade — they abort during startup, usually after clearing the
 * screen, which leaves a card that looks blank rather than failed. Saying so
 * before the launch is the only place the user can still act on it.
 *
 * Free physical memory is the input because that is what the system reports
 * cheaply. It understates the trouble on a machine with no page file, where
 * the commit limit is the physical memory, and overstates it slightly where a
 * generous page file exists — so the warning is worded as a risk, never as a
 * refusal, and the launch is always still allowed.
 */

/** Rough resident size of one agent CLI, measured on opencode 1.18 (Windows). */
export const AGENT_MEMORY_BYTES = 1024 * 1024 * 1024

/** Headroom the rest of the system needs while the agents come up. */
const RESERVE_BYTES = 1024 * 1024 * 1024

function gigabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * A sentence for the launcher, or `null` when there is enough room.
 *
 * `freeBytes` of 0 or less means "not measured" and is never warned about:
 * a failed stats read must not put a scary line under every launch.
 */
export function launchMemoryWarning(freeBytes: number, sessions: number): string | null {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0 || sessions <= 0) return null
  const needed = sessions * AGENT_MEMORY_BYTES + RESERVE_BYTES
  if (freeBytes >= needed) return null
  const affordable = Math.max(0, Math.floor((freeBytes - RESERVE_BYTES) / AGENT_MEMORY_BYTES))
  const advice =
    affordable >= 1
      ? `about ${affordable} at a time is safe here.`
      : 'even one may fail — close something first.'
  return `Only ${gigabytes(freeBytes)} of memory free. Each agent needs roughly 1 GB, so ${advice}`
}
