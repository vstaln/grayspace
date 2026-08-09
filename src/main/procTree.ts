import { execFileSync } from 'child_process'

/**
 * Kills every process whose ancestry (through Win32_Process ParentProcessId)
 * chains back to `rootPid` — including detached ones that survived a plain
 * tree kill. Runs after a short settle delay so the sweep only sees true
 * survivors, and is fully best-effort: no survivors, no PowerShell, or a race
 * with the tree kill all resolve to nothing. No-op on non-Windows.
 */
export function killProcessTree(rootPid: number | undefined, settleMs = 300): void {
  if (process.platform !== 'win32' || !rootPid || !Number.isInteger(rootPid)) return
  setTimeout(() => {
    const script = [
      `$root = ${rootPid}`,
      '$snap = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId',
      '$parents = @{}',
      'foreach ($p in $snap) { $parents[[int]$p.ProcessId] = [int]$p.ParentProcessId }',
      '$kill = @()',
      'foreach ($p in $snap) {',
      '  $cur = [int]$p.ProcessId',
      '  $depth = 0',
      '  while ($cur -gt 0 -and $depth -lt 64) {',
      '    if ($cur -eq $root) { $kill += [int]$p.ProcessId; break }',
      '    if (-not $parents.ContainsKey($cur)) { break }',
      '    $cur = $parents[$cur]',
      '    $depth += 1',
      '  }',
      '}',
      '$kill | Sort-Object -Unique | Where-Object { $_ -ne $root } | ForEach-Object {',
      '  taskkill /PID $_ /T /F 2>$null | Out-Null',
      '}'
    ].join('\n')
    try {
      // -EncodedCommand avoids every quoting/escaping hazard in the script.
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        timeout: 10_000
      })
    } catch {
      /* best-effort: nothing left to kill, or the sweep itself failed */
    }
  }, settleMs)
}
