import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { buildSweepScript, killProcessTree } from './procTree.ts'

describe('killProcessTree script', () => {
  test('refuses to sweep when the pid was reused after the kill request', () => {
    const script = buildSweepScript(4242, 1_700_000_000_000)
    assert.match(script, /pid = 4242/)
    assert.match(script, /notAfter = \[int64\]1700000000000/)
    assert.match(script, /CreationDate/)
    assert.match(script, /if \(\$created\.ContainsKey\(\$rp\) -and \$created\[\$rp\] -gt \$r\.notAfter\) \{ continue \}/)
  })

  test('one sweep covers every root in the batch', () => {
    const script = buildSweepScript([
      { pid: 11, requestedAt: 1_700_000_000_000 },
      { pid: 22, requestedAt: 1_700_000_000_500 }
    ])
    assert.match(script, /pid = 11; notAfter = \[int64\]1700000000000/)
    assert.match(script, /pid = 22; notAfter = \[int64\]1700000000500/)

    assert.equal(script.match(/Get-CimInstance/g)?.length, 1)
  })

  test('the WMI query asks only for the columns the ancestry walk needs', () => {
    const script = buildSweepScript(7, 1)
    assert.match(script, /-Property ProcessId,ParentProcessId,CreationDate/)
  })

  test('roots and their descendants are swept and killed', () => {
    const script = buildSweepScript(9, 1)
    assert.match(script, /taskkill \/PID \$_ \/T \/F/)
    assert.match(script, /\$kill \| Sort-Object -Unique/)
  })

  test('a large batch of roots is covered in a single WMI snapshot', () => {
    const roots = Array.from({ length: 100 }, (_, i) => ({ pid: 1000 + i, requestedAt: Date.now() }))
    const script = buildSweepScript(roots)
    assert.equal(script.match(/pid = \d+/g)?.length, 100)
    assert.equal(script.match(/Get-CimInstance/g)?.length, 1)
  })

  test('on unix the whole process group is signalled, not just the shell', () => {
    if (process.platform === 'win32') return

    // node-pty gives the shell its own session, so its pid doubles as the
    // process-group id. Signalling the bare pid left agents, dev servers and
    // every other grandchild running headless after the widget was closed —
    // the very thing the Windows sweep exists to prevent.
    const signalled: number[] = []
    const realKill = process.kill
    process.kill = ((pid: number, signal?: string | number) => {
      signalled.push(pid)
      void signal
    }) as typeof process.kill
    try {
      killProcessTree(4321)
    } finally {
      process.kill = realKill
    }

    assert.deepEqual(signalled, [-4321], 'the negative pid targets the whole group')
  })

  test('an invalid pid is never signalled', () => {
    const signalled: number[] = []
    const realKill = process.kill
    process.kill = ((pid: number) => {
      signalled.push(pid)
    }) as typeof process.kill
    try {
      // 0 means 'my own process group' to kill(2): letting one through would
      // have the app kill itself.
      killProcessTree(0)
      killProcessTree(-1)
      killProcessTree(undefined)
      killProcessTree(1.5)
    } finally {
      process.kill = realKill
    }

    assert.deepEqual(signalled, [])
  })
})
