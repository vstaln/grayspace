import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createModeRecoveryProbe,
  hasOrphanedModes,
  readChildTitle,
  readEchoedMouseReports
} from './terminalModeRecovery.ts'
import { isShellOwnTitle } from './terminalStartupFailure.ts'

describe('echoed mouse reports', () => {
  // Exactly the shape a crashed opencode leaves in the prompt.
  const caret = '^[[<35;36;37M^[[<35;37;37M^[[<35;38;36M'
  const raw = '\u001b[<35;36;37M\u001b[<35;37;37M\u001b[<35;38;36M'

  it('reports a burst the shell echoed in caret notation', () => {
    const probe = createModeRecoveryProbe()
    assert.equal(readEchoedMouseReports(probe, caret), true)
  })

  it('ignores reports that arrive as real escape sequences', () => {
    // A report with its ESC intact is not something a shell drew — the parser
    // consumes it as a control sequence and nothing reaches the screen. There
    // is no garbage to clean up, so there is nothing to react to. What the
    // shells actually echo is the *text* of the report, with the ESC already
    // eaten by their line editor: `^[[<…` in cmd, `[555;…` in PowerShell.
    const probe = createModeRecoveryProbe()
    assert.equal(readEchoedMouseReports(probe, raw), false)
  })

  it('stays quiet for a single printed sequence', () => {
    const probe = createModeRecoveryProbe()
    assert.equal(readEchoedMouseReports(probe, 'the report looks like ^[[<35;36;37M'), false)
  })

  it('stays quiet for reports an agent merely printed in prose', () => {
    // This file itself is such output. Counting them would reset the terminal
    // of an agent that only displayed them, which is the worse bug.
    const probe = createModeRecoveryProbe()
    const prose =
      'a press is ^[[<0;10;5M, a release ^[[<0;10;5m, and motion ^[[<35;36;37M.\r\n'
    for (let i = 0; i < 20; i++) assert.equal(readEchoedMouseReports(probe, prose), false)
  })

  it('counts a burst that wrapped across lines', () => {
    const probe = createModeRecoveryProbe()
    const wrapped = '^[[<35;36;37M\r\n^[[<35;37;37M\r\n^[[<35;38;36M'
    assert.equal(readEchoedMouseReports(probe, wrapped), true)
  })

  it('stays quiet for ordinary agent output', () => {
    const probe = createModeRecoveryProbe()
    const banner = '\u001b[38;2;237;237;237mopencode\u001b[m  Ask anything…\r\n'
    for (let i = 0; i < 40; i++) assert.equal(readEchoedMouseReports(probe, banner), false)
  })

  it('accumulates reports that arrive one chunk at a time', () => {
    const probe = createModeRecoveryProbe()
    assert.equal(readEchoedMouseReports(probe, '^[[<35;36;37M'), false)
    assert.equal(readEchoedMouseReports(probe, '^[[<35;37;37M'), false)
    assert.equal(readEchoedMouseReports(probe, '^[[<35;38;36M'), true)
  })

  it('sees a report split across a transport boundary', () => {
    const probe = createModeRecoveryProbe()
    assert.equal(readEchoedMouseReports(probe, '^[[<35;36;37M^[[<35;37;37M^[[<35;'), false)
    assert.equal(readEchoedMouseReports(probe, '38;36M'), true)
  })

  it('does not count the same burst twice', () => {
    const probe = createModeRecoveryProbe()
    assert.equal(readEchoedMouseReports(probe, caret), true)
    // The tail of the burst just consumed must not carry into the next one.
    assert.equal(readEchoedMouseReports(probe, '^[[<35;39;36M'), false)
  })

  /**
   * PowerShell does not echo the reports the way cmd does. PSReadLine repaints
   * the input line with syntax highlighting, so it draws `[555;87;30M` and puts
   * a colour code between every token. Both differences mattered: the pattern
   * did not match the drawn form, and even if it had, the colour codes sat
   * between the reports and broke the adjacency the burst is counted by.
   *
   * The strings below are taken verbatim from a real ConPTY capture.
   */
  const psReport = (x: number, y: number): string =>
    `[555\u001b[0m\u001b[37m;\u001b[0m\u001b[97m${x}\u001b[0m\u001b[37m;\u001b[0m\u001b[93m${y}M`

  it('reports a burst PowerShell echoed through its highlighter', () => {
    const probe = createModeRecoveryProbe()
    const burst = psReport(87, 30) + psReport(88, 31) + psReport(89, 32)
    assert.equal(readEchoedMouseReports(probe, burst), true)
  })

  it('counts a PowerShell burst split across chunks', () => {
    const probe = createModeRecoveryProbe()
    assert.equal(readEchoedMouseReports(probe, psReport(87, 30)), false)
    assert.equal(readEchoedMouseReports(probe, psReport(88, 31)), false)
    assert.equal(readEchoedMouseReports(probe, psReport(89, 32)), true)
  })

  it('stays quiet for a PowerShell prompt with no reports in it', () => {
    const probe = createModeRecoveryProbe()
    const prompt = '\u001b[0m\u001b[37mPS \u001b[0m\u001b[97mC:\\Users\\user\u001b[0m> '
    for (let i = 0; i < 20; i++) assert.equal(readEchoedMouseReports(probe, prompt), false)
  })

  it('stays quiet for a coloured TUI frame', () => {
    // Colour codes carry numbers and semicolons of their own; stripping them
    // must not leave anything that reads as a report.
    const probe = createModeRecoveryProbe()
    const frame =
      '\u001b[38;2;120;160;255m\u001b[48;5;236m   \u001b[1;31;42m\u001b[2J\u001b[10;20H'
    for (let i = 0; i < 40; i++) assert.equal(readEchoedMouseReports(probe, frame), false)
  })
})

describe('shell-owned console titles', () => {
  it('recognises an idle shell', () => {
    for (const title of [
      'C:\\WINDOWS\\system32\\cmd.exe',
      'cmd.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'Windows PowerShell',
      '/bin/bash'
    ]) {
      assert.equal(isShellOwnTitle(title), true, title)
    }
  })

  it('does not mistake a running child for an idle shell', () => {
    for (const title of [
      'C:\\WINDOWS\\system32\\cmd.exe - opencode',
      'opencode',
      ''
    ]) {
      assert.equal(isShellOwnTitle(title), false, title)
    }
  })

})

describe('child-exit titles', () => {
  const title = (value: string): string => `\u001b]0;${value}\u0007`
  const SHELL = 'C:\\WINDOWS\\system32\\cmd.exe'

  it('reports the shell taking its title back from a child', () => {
    const probe = createModeRecoveryProbe()
    assert.equal(readChildTitle(probe, title(`${SHELL} - opencode`)), 'started')
    assert.equal(readChildTitle(probe, title(SHELL)), 'exited')
  })

  it('ignores a shell that names itself and never ran anything', () => {
    const probe = createModeRecoveryProbe()
    // PowerShell sets this once and re-emits it on repaint; no child ever ran,
    // so nothing has exited and nothing may be reset.
    for (let i = 0; i < 5; i++) {
      assert.equal(readChildTitle(probe, title('Windows PowerShell')), null)
    }
  })

  it('reports each exit once', () => {
    const probe = createModeRecoveryProbe()
    readChildTitle(probe, title(`${SHELL} - opencode`))
    assert.equal(readChildTitle(probe, title(SHELL)), 'exited')
    assert.equal(readChildTitle(probe, title(SHELL)), null)
  })

  it('reads titles inside one chunk in order', () => {
    const probe = createModeRecoveryProbe()
    // A launcher shim restoring the title on its way to starting the agent:
    // the chunk ends on a running child, so nothing exited.
    const chunk = `${title(`${SHELL} - codex`)}${title(SHELL)}${title(`${SHELL} - node`)}`
    assert.equal(readChildTitle(probe, chunk), 'started')
  })

  it('says nothing for output with no titles', () => {
    assert.equal(readChildTitle(createModeRecoveryProbe(), 'no title here'), null)
  })

  it('joins a title split across two chunks', () => {
    // The pty splits wherever it likes, and a chunk holding half a title used
    // to be dropped by both halves. Measured on a real PowerShell that cost
    // the recovery every event it had: a whole agent run produced none.
    const probe = createModeRecoveryProbe()
    const started = title('OpenCode')
    assert.equal(readChildTitle(probe, started.slice(0, 6)), null)
    assert.equal(readChildTitle(probe, started.slice(6)), 'started')

    const exited = title('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.equal(readChildTitle(probe, exited.slice(0, 20)), null)
    assert.equal(readChildTitle(probe, exited.slice(20)), 'exited')
  })

  it('never reads the same title twice through the carry', () => {
    const probe = createModeRecoveryProbe()
    assert.equal(readChildTitle(probe, title('OpenCode')), 'started')
    assert.equal(readChildTitle(probe, 'plain output, no titles'), null)
    assert.equal(readChildTitle(probe, title(SHELL)), 'exited')
    assert.equal(readChildTitle(probe, 'more plain output'), null)
  })

  it('does not grow the carry on output that never terminates a sequence', () => {
    const probe = createModeRecoveryProbe()
    for (let i = 0; i < 50; i += 1) readChildTitle(probe, 'x'.repeat(400))
    assert.ok(probe.titleCarry.length <= 512, `carry grew to ${probe.titleCarry.length}`)
  })

  it('reads a whole replayed history as one chunk', () => {
    // A widget remounting onto a live shell replays its entire scrollback in
    // one go, straight to the parser. That history carries the crash's
    // `1049h` and mouse modes, so it re-strands the emulator — and the only
    // thing left to notice it by is the child exit recorded in the same
    // history. Shape taken from a real capture: launcher shims first, the
    // agent, then the exit.
    const probe = createModeRecoveryProbe()
    const history =
      `${title(`${SHELL} - chcp`)}${title(SHELL)}` +
      `${title(`${SHELL} - opencode`)}\u001b[?1049h\u001b[?1003h\u001b[?1006h` +
      'opencode painting its screen…' +
      title(SHELL)
    assert.equal(readChildTitle(probe, history), 'exited')
  })

  it('does not read a healthy live session as an exit', () => {
    // Same replay, but the agent is still up: the history ends on its title.
    const probe = createModeRecoveryProbe()
    const history = `${title(SHELL)}${title(`${SHELL} - opencode`)}\u001b[?1049h`
    assert.equal(readChildTitle(probe, history), 'started')
  })
})

describe('orphaned modes', () => {
  it('is true for mouse tracking at a shell prompt', () => {
    assert.equal(hasOrphanedModes({ bufferType: 'normal', mouseTracking: 'any' }), true)
  })

  it('treats the alternate buffer as evidence, not as a reason to stand down', () => {
    // This asserted the opposite at first: on the alternate screen something
    // must still be running, so leave it alone. Measuring a real PowerShell
    // disproved it — a hard-killed opencode leaves the terminal on the
    // alternate buffer *and* the shell echoing mouse reports into it, so the
    // old rule declined to act in precisely the state it was written for.
    assert.equal(hasOrphanedModes({ bufferType: 'alternate', mouseTracking: 'any' }), true)
    assert.equal(hasOrphanedModes({ bufferType: 'alternate', mouseTracking: 'none' }), true)
  })

  it('is false for a plain shell', () => {
    assert.equal(hasOrphanedModes({ bufferType: 'normal', mouseTracking: 'none' }), false)
    assert.equal(hasOrphanedModes({ bufferType: 'normal' }), false)
  })

  it('recovers a terminal stranded on the alternate screen by a crash', () => {
    // Measured from a real ConPTY: an opencode killed the way a Bun panic
    // kills it leaves `1049h` with no `1049l`. Nothing is running, and a shell
    // never asks for the alternate buffer, so being on it *is* the evidence.
    assert.equal(
      hasOrphanedModes({ bufferType: 'alternate', mouseTracking: 'none' }),
      true
    )
  })

  it('recovers stranded mouse tracking after the child is gone', () => {
    assert.equal(
      hasOrphanedModes({ bufferType: 'normal', mouseTracking: 'any' }),
      true
    )
  })

  it('does nothing when an exited child left the terminal clean', () => {
    assert.equal(
      hasOrphanedModes({ bufferType: 'normal', mouseTracking: 'none' }),
      false
    )
  })

  it('recovers origin mode left behind by a clean alternate-screen exit', () => {
    // The Ctrl-C/Codex case: the TUI restored the normal buffer and turned
    // mouse reporting off, but died with origin mode (and its scroll region)
    // still set — so the shell prompt is trapped on the top row.
    assert.equal(
      hasOrphanedModes({ bufferType: 'normal', mouseTracking: 'none', originMode: true }),
      true
    )
  })

  it('recovers a stuck synchronized-output frame after the child is gone', () => {
    assert.equal(
      hasOrphanedModes({ bufferType: 'normal', mouseTracking: 'none', synchronizedOutputMode: true }),
      true
    )
  })

  it('recovers insert mode and a disabled autowrap left by a dead TUI', () => {
    assert.equal(
      hasOrphanedModes({ bufferType: 'normal', mouseTracking: 'none', insertMode: true }),
      true
    )
    assert.equal(
      hasOrphanedModes({ bufferType: 'normal', mouseTracking: 'none', wraparoundMode: false }),
      true
    )
  })

  it('stays quiet for a healthy shell that reports all modes', () => {
    assert.equal(
      hasOrphanedModes({
        bufferType: 'normal',
        mouseTracking: 'none',
        originMode: false,
        synchronizedOutputMode: false,
        insertMode: false,
        wraparoundMode: true
      }),
      false
    )
  })
})
