import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ChatRunner } from './chatRunner.ts'
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

describe('ChatRunner', () => {
  test('rejects invalid thread id', () => {
    const runner = new ChatRunner()
    const res = runner.send('invalid thread id with spaces!', 'claude', 'Hello')
    assert.equal(res.ok ? 'ok' : res.error, 'invalid thread id')
  })

  test('rejects unknown model', () => {
    const runner = new ChatRunner()
    // @ts-expect-error test unknown model validation
    const res = runner.send('thread-1', 'gpt9000', 'Hello')
    assert.match(res.ok ? 'ok' : res.error, /unknown model/)
  })

  test('rejects empty or whitespace-only prompt', () => {
    const runner = new ChatRunner()
    const res = runner.send('thread-1', 'claude', '   \n  \t ')
    assert.equal(res.ok ? 'ok' : res.error, 'empty prompt')
  })

  test('rejects prompt exceeding max limit', () => {
    const runner = new ChatRunner()
    const oversized = 'a'.repeat(33_000)
    const res = runner.send('thread-1', 'claude', oversized)
    assert.match(res.ok ? 'ok' : res.error, /exceeds 32000 characters/)
  })

  test('tracks running state and stop/dispose', () => {
    const runner = new ChatRunner()
    assert.equal(runner.isRunning('thread-1'), false)
    assert.equal(runner.stop('thread-1'), false)
    runner.dispose('thread-1')
    assert.equal(runner.isRunning('thread-1'), false)
  })
})
