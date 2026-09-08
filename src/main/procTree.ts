import { execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import { defaultShell } from './config.ts'


























const pendingRoots = new Map<number, number>()
let sweepTimer: ReturnType<typeof setTimeout> | null = null
let sweepInFlight = false
let sweepProcess: ChildProcess | null = null
let lastSweepEndedAt = 0





let sweepGeneration = 0


const SWEEP_DEBOUNCE_MS = 1_200

const SWEEP_COOLDOWN_MS = 4_000








const MAX_ROOTS_PER_SWEEP = 256

export function killProcessTree(rootPid: number | undefined, settleMs = SWEEP_DEBOUNCE_MS): void {
  if (process.platform !== 'win32' || !rootPid || !Number.isInteger(rootPid) || rootPid <= 0) return

  try {
    execFile('taskkill', ['/PID', String(rootPid), '/T', '/F'], { windowsHide: true }, () => {})
  } catch {

  }



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


    if (generation !== sweepGeneration) {
      sweepInFlight = false
      sweepProcess = null
      return
    }
    sweepInFlight = false
    sweepProcess = null
    lastSweepEndedAt = Date.now()

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

    }
    sweepProcess = null
  }
  sweepInFlight = false
}


export function pendingSweepRoots(): number[] {
  return Array.from(pendingRoots.keys())
}







export function buildSweepScript(
  roots: number | Array<{ pid: number; requestedAt: number }>,
  notCreatedAfterMs?: number
): string {
  const list =
    typeof roots === 'number' ? [{ pid: roots, requestedAt: notCreatedAfterMs ?? Date.now() }] : roots
  const rootLiterals = list.map((r) => `@{ pid = ${r.pid}; notAfter = [int64]${r.requestedAt} }`)
  return [
    `$requested = @(${rootLiterals.join(', ')})`,


    '$snap = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction SilentlyContinue',
    'if (-not $snap) { return }',
    '$parents = @{}',
    '$created = @{}',
    'foreach ($p in $snap) {',
    '  $pid_ = [int]$p.ProcessId',
    '  $parents[$pid_] = [int]$p.ParentProcessId',
    '  if ($p.CreationDate) { $created[$pid_] = [int64]([DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()) }',
    '}',

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



    '$kill | Sort-Object -Unique | ForEach-Object {',
    '  taskkill /PID $_ /T /F 2>$null | Out-Null',
    '}'
  ].join('\n')
}
