import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conptyStartupOutput } from './conpty.ts'

test('startup DA1 is answered once across every transport split, without changing other output', () => {
  const probe = '\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h'
  for (let split = 0; split <= probe.length; split++) {
    const replies: string[] = []
    const consume = conptyStartupOutput(data => replies.push(data))
    const output = consume(probe.slice(0, split)) + consume(probe.slice(split))
    assert.equal(output, probe.replace('\x1b[c', ''))
    assert.deepEqual(replies, ['\x1b[?61;6;22c'])
    assert.equal(consume('app\x1b[c'), 'app\x1b[c')
    assert.equal(replies.length, 1)
  }
})

test('system-host output and later application queries pass through unchanged', () => {
  const replies: string[] = []
  const consume = conptyStartupOutput(data => replies.push(data))
  assert.equal(consume('\x1b[?25hC:\\project>'), '\x1b[?25hC:\\project>')
  assert.equal(consume('\x1b[c'), '\x1b[c')
  assert.deepEqual(replies, [])
})

// A host that asks twice and is answered once still withholds the shell, which
// is the hang this filter exists to make impossible. Answering the first query
// and standing down is therefore not enough: it stays armed until the shell
// actually speaks, and answers every query class a host can block on.
test('every startup query is answered, not only the first', () => {
  const replies: string[] = []
  const consume = conptyStartupOutput(data => replies.push(data))
  const preamble = '\x1b[1t\x1b[c\x1b[?1004h\x1b[6n\x1b[>c\x1b[?6n\x1b[=c'
  assert.equal(consume(preamble), '\x1b[1t\x1b[?1004h')
  assert.deepEqual(replies, [
    '\x1b[?61;6;22c',
    '\x1b[1;1R',
    '\x1b[>0;10;1c',
    '\x1b[?1;1;1R',
    '\x1bP!|00000000\x1b\\'
  ])
})

test('queries stop being answered as soon as the shell has printed something', () => {
  const replies: string[] = []
  const consume = conptyStartupOutput(data => replies.push(data))
  assert.equal(consume('\x1b[c'), '')
  assert.equal(consume('C:\\project>'), 'C:\\project>')
  const appQueries = '\x1b[c\x1b[6n\x1b[>c'
  assert.equal(consume(appQueries), appQueries)
  assert.deepEqual(replies, ['\x1b[?61;6;22c'])
})

// ConPTY announces the console window title before the shell says anything.
// Its payload is arbitrary text, so a scanner that only understands CSI reads
// it as "the shell has started" and never answers the handshake — which is the
// multi-second startup stall the answer exists to prevent.
test('a window title ahead of the DA1 is not mistaken for shell output', () => {
  for (const terminator of ['\x07', '\x1b\\']) {
    const replies: string[] = []
    const consume = conptyStartupOutput(data => replies.push(data))
    const title = `\x1b]0;C:\\WINDOWS\\system32\\cmd.exe${terminator}`
    assert.equal(consume(`${title}\x1b[c`), title)
    assert.deepEqual(replies, ['\x1b[?61;6;22c'])
  }
})

test('a title split across chunks is held and released in order, losing nothing', () => {
  const replies: string[] = []
  const consume = conptyStartupOutput(data => replies.push(data))
  assert.equal(consume('\x1b]0;cmd.exe'), '')
  assert.deepEqual(replies, [])
  assert.equal(consume('\x07\x1b[c\x1b[?25h'), '\x1b]0;cmd.exe\x07\x1b[?25h')
  assert.deepEqual(replies, ['\x1b[?61;6;22c'])
})

test('a sequence that never terminates is released instead of held forever', () => {
  const replies: string[] = []
  const consume = conptyStartupOutput(data => replies.push(data))
  const runaway = '\x1b[' + '1'.repeat(600)
  assert.equal(consume(runaway), runaway)
  assert.equal(consume('\x1b[c'), '\x1b[c')
  assert.deepEqual(replies, [])
})

test('a host that never asks stops the filter instead of arming it for the session', () => {
  const replies: string[] = []
  const consume = conptyStartupOutput(data => replies.push(data))
  const quiet = '\x1b[?7h'.repeat(1000)
  assert.equal(consume(quiet), quiet)
  // Past the scan budget this is an application's query, not a handshake.
  assert.equal(consume('\x1b[c'), '\x1b[c')
  assert.deepEqual(replies, [])
})
