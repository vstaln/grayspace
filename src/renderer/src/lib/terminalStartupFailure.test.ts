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
  const title = (value: string): string => `\u001b]0;${value}\u0007`
  const SHELL = 'C:\\WINDOWS\\system32\\cmd.exe'
  const started = title(`${SHELL} - opencode`)
  const backToShell = title(SHELL)

  it('reports an agent that died without printing anything', () => {
    const probe = createStartupProbe('opencode')
    assert.equal(readStartupOutput(probe, `C:\\work>opencode\r\n${started}`)?.status, 'running')
    const verdict = readStartupOutput(probe, backToShell)
    assert.equal(verdict?.status, 'maybe-exited')
    assert.match(verdict?.status === 'maybe-exited' ? verdict.message : '', /exited right after starting/)
  })

  it('stays quiet while the agent keeps running', () => {
    const probe = createStartupProbe('opencode')
    assert.equal(readStartupOutput(probe, started)?.status, 'running')
    assert.equal(readStartupOutput(probe, '\u001b[?1049hopencode  Ask anything…'), null)
    assert.equal(readStartupOutput(probe, title('opencode \u2014 build'))?.status, 'running')
  })

  it('ignores a shell title that arrives before the agent ever ran', () => {
    const probe = createStartupProbe('opencode')
    assert.equal(readStartupOutput(probe, backToShell), null)
    assert.equal(readStartupOutput(probe, backToShell), null)
  })

  it('joins a title split across two chunks and reads it once', () => {
    const probe = createStartupProbe('opencode')
    assert.equal(readStartupOutput(probe, `\u001b]0;${SHELL} - openc`), null)
    assert.equal(readStartupOutput(probe, 'ode\u0007')?.status, 'running')
    assert.equal(probe.started, true)
    assert.equal(readStartupOutput(probe, backToShell)?.status, 'maybe-exited')
  })

  it('prefers the printed reason over the bare exit', () => {
    const probe = createStartupProbe('opencode')
    readStartupOutput(probe, started)
    const verdict = readStartupOutput(probe, `memory full\r\n${backToShell}`)
    assert.equal(verdict?.status, 'failed')
    assert.match(verdict?.status === 'failed' ? verdict.message : '', /ran out of memory/)
  })

  // Captured from a real `codex` launch: the npm shim runs `title` to undo the
  // suffix cmd.exe added, so the bare shell title arrives ~2ms before the
  // agent's own process does. Reporting on that title is the false
  // "codex exited right after starting" banner.
  it('does not read a launcher shim restoring the title as an exit', () => {
    const probe = createStartupProbe('codex')
    assert.equal(readStartupOutput(probe, title(`${SHELL} - codex`))?.status, 'running')
    assert.equal(readStartupOutput(probe, title(`${SHELL} - codex - title  ${SHELL} `))?.status, 'running')
    assert.equal(readStartupOutput(probe, title(`${SHELL} `))?.status, 'maybe-exited')
    // The next title supersedes it, which is what the caller waits for.
    const resumed = readStartupOutput(probe, title(`${SHELL}  - "node"   "C:\\npm\\@openai\\codex\\bin\\codex.js" `))
    assert.equal(resumed?.status, 'running')
    assert.equal(readStartupOutput(probe, title('Orcpace'))?.status, 'running')
    assert.equal(readStartupOutput(probe, title('\u2819 Orcpace'))?.status, 'running')
  })

  it('lets a chunk that ends on a live command outweigh an earlier bare title', () => {
    const probe = createStartupProbe('codex')
    readStartupOutput(probe, title(`${SHELL} - codex`))
    const batched = `${title(`${SHELL} `)}${title(`${SHELL}  - "node"  "codex.js"`)}`
    assert.equal(readStartupOutput(probe, batched)?.status, 'running')
  })
})
