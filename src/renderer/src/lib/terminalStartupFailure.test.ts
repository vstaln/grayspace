import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createStartupProbe,
  plainTerminalText,
  readStartupOutput,
  startupFailureMessage
} from './terminalStartupFailure.ts'

describe('terminal startup failure', () => {
  it('reads the cmd.exe out-of-memory line', () => {
    const output = 'C:\\work>opencode\u001b[K\r\n\u001b[3;1Hmemory full\r\n'
    const message = startupFailureMessage(output, 'opencode')
    assert.ok(message?.startsWith('opencode could not start: the system ran out of memory'))
  })

  it('reads a JavaScriptCore abort split by cursor moves', () => {
    // Exactly the shape ConPTY produced for a Bun agent aborting at startup.
    const output =
      'A\u001b[54C\u001b[26;2HSSERTION FAILED: MemoryExhaustion: Crash intentionally\r\n' +
      '\u001b[25;55Hy because memory is exhausted.\u001b[26C\r\n'
    assert.match(
      startupFailureMessage(output, 'opencode') ?? '',
      /ran out of memory/
    )
  })

  it('reads a missing command in both shells and locales', () => {
    for (const line of [
      "'opencode' is not recognized as an internal or external command",
      'opencode : не является внутренней или внешней командой',
      'bash: opencode: command not found'
    ]) {
      assert.match(startupFailureMessage(line, 'opencode') ?? '', /not found on PATH/)
    }
  })

  it('names the executable, not the whole command line', () => {
    assert.match(startupFailureMessage('memory full', 'opencode --model x') ?? '', /^opencode /)
  })

  it('stays quiet for ordinary agent output', () => {
    const banner = '\u001b[38;2;237;237;237mopencode\u001b[m  Ask anything… "Fix broken tests"'
    assert.equal(startupFailureMessage(banner, 'opencode'), null)
  })

  it('strips escapes and collapses whitespace', () => {
    assert.equal(plainTerminalText('\u001b[31mred\u001b[m   text\r\n'), ' red text ')
  })
})

describe('terminal startup probe', () => {
  const started = '\u001b]0;C:\\WINDOWS\\system32\\cmd.exe - opencode\u0007'
  const backToShell = '\u001b]0;C:\\WINDOWS\\system32\\cmd.exe\u0007'

  it('reports an agent that died without printing anything', () => {
    const probe = createStartupProbe('opencode')
    assert.equal(readStartupOutput(probe, `C:\\work>opencode\r\n${started}`), null)
    assert.match(readStartupOutput(probe, backToShell) ?? '', /exited right after starting/)
  })

  it('stays quiet while the agent keeps running', () => {
    const probe = createStartupProbe('opencode')
    assert.equal(readStartupOutput(probe, started), null)
    assert.equal(readStartupOutput(probe, '\u001b[?1049hopencode  Ask anything…'), null)
    assert.equal(readStartupOutput(probe, '\u001b]0;opencode \u2014 build\u0007'), null)
  })

  it('ignores a shell title that arrives before the agent ever ran', () => {
    const probe = createStartupProbe('opencode')
    assert.equal(readStartupOutput(probe, backToShell), null)
    assert.equal(readStartupOutput(probe, backToShell), null)
  })

  it('joins a title split across two chunks and reads it once', () => {
    const probe = createStartupProbe('opencode')
    assert.equal(readStartupOutput(probe, '\u001b]0;C:\\WINDOWS\\system32\\cmd.exe - openc'), null)
    assert.equal(readStartupOutput(probe, 'ode\u0007'), null)
    assert.equal(probe.started, true)
    assert.match(readStartupOutput(probe, backToShell) ?? '', /exited right after starting/)
  })

  it('prefers the printed reason over the bare exit', () => {
    const probe = createStartupProbe('opencode')
    readStartupOutput(probe, started)
    assert.match(readStartupOutput(probe, `memory full\r\n${backToShell}`) ?? '', /ran out of memory/)
  })
})
