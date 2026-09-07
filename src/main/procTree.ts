import { execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import { defaultShell } from './config.ts'

/**
 * Kills every process whose ancestry (through Win32_Process ParentProcessId)
 * chains back to a root pid — including detached ones that survived a plain
 * tree kill. No-op on non-Windows, and fully best-effort throughout: no
 * survivors, no PowerShell, or a race with the tree kill all resolve to
 * nothing.
 *
 * Two things happen per call:
 *
 *  1. `taskkill /T /F`, immediately. This is native, costs a few milliseconds,
 *     and already handles the overwhelmingly common case — the shell and its
 *     ordinary children.
 *  2. A deep sweep for detached survivors (`Start-Process`, a new console
 *     session) whose ancestry still chains back to the root on Windows but
 *     which `taskkill /T` no longer reaches.
 *
 * Step 2 is the expensive one: PowerShell startup plus a WMI walk of the whole
 * process table, together roughly half a second of CPU. Running it per closed
 * terminal is what made closing two or three shells in a row stall the app, so
 * sweeps are *coalesced*: every root requested inside the debounce window is
 * swept by one PowerShell run, and consecutive sweeps are spaced by a cooldown.
 * Closing five terminals now costs one sweep instead of five.
 */

/** Roots waiting to be swept, with the instant each was still known to be ours. */
const pendingRoots = new Map<number, number>()
let sweepTimer: ReturnType<typeof setTimeout> | null = null
let sweepInFlight = false
let sweepProcess: ChildProcess | null = null
let lastSweepEndedAt = 0
/**
 * Bumped by every cancel (shutdown). An in-flight sweep that finishes after a
 * cancel must not reschedule or touch shared state: its pids may already be
 * recycled by the next app instance.
 */
let sweepGeneration = 0

/** How long to gather roots before sweeping — also the settle delay of old. */
const SWEEP_DEBOUNCE_MS = 1_200
/** Minimum quiet time between two sweeps, so a burst of closes cannot chain them. */
const SWEEP_COOLDOWN_MS = 4_000
/**
 * A single sweep covers at most this many roots. The cost of a sweep is
 * dominated by the single WMI snapshot (~50 ms on a normal workstation), not
 * the per-root dictionary lookups, so the previous 32-root cap silently lost
 * deep sweeps for any terminals past the 32nd when many shells were closed
 * together (e.g. on shutdown). 256 covers the practical maximum of any
 * single canvas without risking a runaway script.
 */
const MAX_ROOTS_PER_SWEEP = 256

export function killProcessTree(rootPid: number | undefined, settleMs = SWEEP_DEBOUNCE_MS): void {
  if (process.platform !== 'win32' || !rootPid || !Number.isInteger(rootPid) || rootPid <= 0) return

  try {
    execFile('taskkill', ['/PID', String(rootPid), '/T', '/F'], { windowsHide: true }, () => {})
  } catch {
    /* process may already be gone */
  }

  // Capture the instant we still know this pid is *ours*. By the time the sweep
  // runs a recycled pid would have a newer CreationDate — the script skips it.
  if (!pendingRoots.has(rootPid)) {
    if (pendingRoots.size >= MAX_ROOTS_PER_SWEEP) {
      const oldestKey = Array.from(pendingRoots.keys())[0]
      if (oldestKey !== undefined) pendingRoots.delete(oldestKey)
    }
    pendingRoots.set(rootPid, Date.now())
  }
  scheduleSweep(settleMs)
}

function scheduleSweep(settleMs: number): void {
  if (sweepTimer !== null || sweepInFlight) return
  const sinceLast = Date.now() - lastSweepEndedAt
  const wait = Math.max(settleMs, SWEEP_COOLDOWN_MS - sinceLast)
  sweepTimer = setTimeout(runSweep, wait)
  sweepTimer.unref?.()
}

function runSweep(): void {
  sweepTimer = null
  if (sweepInFlight || pendingRoots.size === 0) return
  const roots = Array.from(pendingRoots, ([pid, requestedAt]) => ({ pid, requestedAt }))
  pendingRoots.clear()
  sweepInFlight = true
  const generation = sweepGeneration

  const finish = (): void => {
    // A cancel (shutdown) happened while this sweep ran: leave everything to
    // the fresh generation instead of rescheduling against recycled pids.
    if (generation !== sweepGeneration) {
      sweepInFlight = false
      sweepProcess = null
      return
    }
    sweepInFlight = false
    sweepProcess = null
    lastSweepEndedAt = Date.now()
    // Roots that arrived while this sweep was running still need one.
    if (pendingRoots.size > 0) scheduleSweep(SWEEP_DEBOUNCE_MS)
  }

  let spawned = false
  try {
    const encoded = Buffer.from(buildSweepScript(roots), 'utf16le').toString('base64')
    spawned = true
    sweepProcess = execFile(
      defaultShell('powershell'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15_000 },
      finish
    )
  } catch {
    // execFile threw synchronously (e.g. powershell.exe missing). Put the roots
    // back so a later sweep can still try; the fast-path taskkill already
    // handled the immediate tree.
    if (spawned) {
      finish()
    } else {
      for (const r of roots) pendingRoots.set(r.pid, r.requestedAt)
      sweepInFlight = false
      lastSweepEndedAt = Date.now()
      if (pendingRoots.size > 0) scheduleSweep(SWEEP_DEBOUNCE_MS)
    }
  }
}

/**
 * Cancels all delayed descendant sweeps before the app exits. The native pty
 * close path has already handled the console process list; allowing a queued
 * WMI sweep to outlive Electron could act on a recycled PID belonging to a
 * different process.
 */
export function cancelPendingProcessTreeSweeps(): void {
  sweepGeneration += 1
  if (sweepTimer !== null) {
    clearTimeout(sweepTimer)
    sweepTimer = null
  }
  pendingRoots.clear()
  if (sweepProcess !== null) {
    try {
      sweepProcess.kill()
    } catch {
      /* already gone */
    }
    sweepProcess = null
  }
  sweepInFlight = false
}

/** Roots still queued for the next sweep. Exported for tests. */
export function pendingSweepRoots(): number[] {
  return Array.from(pendingRoots.keys())
}

/**
 * The PowerShell body, with the pid-reuse guard inlined per root.
 *
 * Exported for tests. Accepts either a single root (the historical shape) or
 * the batch a coalesced sweep actually runs.
 */
export function buildSweepScript(
  roots: number | Array<{ pid: number; requestedAt: number }>,
  notCreatedAfterMs?: number
): string {
  const list =
    typeof roots === 'number' ? [{ pid: roots, requestedAt: notCreatedAfterMs ?? Date.now() }] : roots
  const rootLiterals = list.map((r) => `@{ pid = ${r.pid}; notAfter = [int64]${r.requestedAt} }`)
  return [
    `$requested = @(${rootLiterals.join(', ')})`,
    // Asking for only the three properties the walk needs keeps WMI from
    // materialising ~50 fields per process, which is most of the query's cost.
    '$snap = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction SilentlyContinue',
    'if (-not $snap) { return }',
    '$parents = @{}',
    '$created = @{}',
    'foreach ($p in $snap) {',
    '  $pid_ = [int]$p.ProcessId',
    '  $parents[$pid_] = [int]$p.ParentProcessId',
    '  if ($p.CreationDate) { $created[$pid_] = [int64]([DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()) }',
    '}',
    // A pid the OS recycled after the close request belongs to someone else now.
    '$roots = @{}',
    'foreach ($r in $requested) {',
    '  $rp = [int]$r.pid',
    '  if ($created.ContainsKey($rp) -and $created[$rp] -gt $r.notAfter) { continue }',
    '  $roots[$rp] = $true',
    '}',
    'if ($roots.Count -eq 0) { return }',
    '$kill = @()',
    'foreach ($p in $snap) {',
    '  $cur = [int]$p.ProcessId',
    '  $depth = 0',
    '  while ($cur -gt 0 -and $depth -lt 64) {',
    '    if ($roots.ContainsKey($cur)) { $kill += [int]$p.ProcessId; break }',
    '    if (-not $parents.ContainsKey($cur)) { break }',
    '    $cur = $parents[$cur]',
    '    $depth += 1',
    '  }',
    '}',
    // Roots are included: the fast-path taskkill is best-effort and may have
    // failed (EPERM, transient), leaving the root shell alive while its
    // descendants die. A repeat /F against an already-dead pid costs nothing.
    '$kill | Sort-Object -Unique | ForEach-Object {',
    '  taskkill /PID $_ /T /F 2>$null | Out-Null',
    '}'
  ].join('\n')
}
