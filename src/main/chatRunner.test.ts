import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { buildChatInvocationArgs, buildChatProcessEnv, cleanCodexStderrLine, extractCodexJsonLine, ChatRunner } from './chatRunner.ts'
import { stripAnsi } from './ansi.ts'

describe('stripAnsi', () => {
  test('strips CSI color and styling sequences', () => {
    const input = '\x1b[31;1mError:\x1b[0m \x1b[32mSuccess\x1b[0m'
    assert.equal(stripAnsi(input), 'Error: Success')
  })

  test('strips OSC sequences (hyperlinks, window titles)', () => {
    const input = '\x1b]8;;https://example.com\x07Click here\x1b]8;;\x07'
    assert.equal(stripAnsi(input), 'Click here')
  })

  test('strips DCS / SOS / PM / APC sequences', () => {
    const input = '\x1bP+q5465\x1b\\Visible text\x1b^some pm\x1b\\'
    assert.equal(stripAnsi(input), 'Visible text')
  })

  test('strips C1 8-bit controls', () => {
    const input = 'Hello\x9bWorld\x9d!'
    assert.equal(stripAnsi(input), 'HelloWorld!')
  })

  test('preserves plain text and unicode strings', () => {
    const input = 'Hello, мир! 🚀 Function foo() { return 42; }'
    assert.equal(stripAnsi(input), input)
  })
})

function errOf(res: { ok: true } | { error: string }): string {
  return 'error' in res ? res.error : 'ok'
}

describe('ChatRunner', () => {
  test('runs JavaScript CLI wrappers in Electron Node mode', () => {
    assert.equal(buildChatProcessEnv(true).ELECTRON_RUN_AS_NODE, '1')
  })

  test('uses Codex config override instead of removed --effort flag', () => {
    assert.deepEqual(
      buildChatInvocationArgs('codex', 'fix', {
        model: 'gpt-5.6-luna',
        effort: 'high',
        images: ['C:\\Temp\\screen.png']
      }),
      [
        'exec',
        '--skip-git-repo-check',
        '--json',
        '--model',
        'gpt-5.6-luna',
        '--config',
        'model_reasoning_effort=high',
        '--image',
        'C:\\Temp\\screen.png',
        'fix'
      ]
    )
  })

  test('keeps only assistant text from Codex JSONL output', () => {
    assert.equal(extractCodexJsonLine('{"type":"thread.started","thread_id":"abc"}'), '')
    assert.equal(
      extractCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message","text":"Hey! What can I help you with?"}}'),
      'Hey! What can I help you with?'
    )
    assert.equal(extractCodexJsonLine('{"type":"turn.completed","usage":{"input_tokens":3850}}'), '')
    assert.equal(extractCodexJsonLine('not json'), '')
    assert.equal(cleanCodexStderrLine('Reading additional input from stdin...'), '')
    assert.equal(
      cleanCodexStderrLine('2026-09-05T14:54:06.513216Z WARN codexskills::interface: ignoring interface.iconsmall: icon path with "." must resolve under plugin assets/'),
      ''
    )
    assert.equal(
      cleanCodexStderrLine('2026-09-05T14:54:06.566328Z WARN codexcore::shellsnapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell'),
      ''
    )
    assert.equal(
      cleanCodexStderrLine('2026-09-05T14:54:12.177861Z WARN codex_core::tasks: failed to flush rollout after emitting terminal turn event: thread deadbeef not found'),
      ''
    )
    assert.equal(cleanCodexStderrLine('authentication failed'), 'authentication failed')
  })

  test('rejects invalid thread id', () => {
    const runner = new ChatRunner()
    const res = runner.send('invalid thread id with spaces!', 'claude', 'Hello')
    assert.equal(errOf(res), 'invalid thread id')
  })

  test('rejects unknown model', () => {
    const runner = new ChatRunner()
    // @ts-expect-error test unknown model validation
    const res = runner.send('thread-1', 'gpt9000', 'Hello')
    assert.match(errOf(res), /unknown model/)
  })

  test('rejects empty or whitespace-only prompt', () => {
    const runner = new ChatRunner()
    const res = runner.send('thread-1', 'claude', '   \n  \t ')
    assert.equal(errOf(res), 'empty prompt')
  })

  test('rejects prompt exceeding max limit', () => {
    const runner = new ChatRunner()
    const oversized = 'a'.repeat(33_000)
    const res = runner.send('thread-1', 'claude', oversized)
    assert.match(errOf(res), /exceeds 32000 characters/)
  })

  test('rejects unsafe model ids before spawning a shell wrapper', () => {
    const runner = new ChatRunner()
    const res = runner.send('thread-1', 'claude', 'Hello', undefined, { model: 'safe; calc.exe' })
    assert.equal(errOf(res), 'invalid model id')
  })

  test('tracks running state and stop/dispose', () => {
    const runner = new ChatRunner()
    assert.equal(runner.isRunning('thread-1'), false)
    assert.equal(runner.stop('thread-1'), false)
    runner.dispose('thread-1')
    assert.equal(runner.isRunning('thread-1'), false)
  })
})
