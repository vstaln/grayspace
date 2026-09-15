import test from 'node:test'
import assert from 'node:assert/strict'
import { preserveSgr } from './ansi.ts'

test('ANSI sanitizers remove C1 control sequences without losing visible text', () => {
  const value = `before\u009d52;c;secret\u009c\u0090private\u009c\u009b31mred\u009b0m after`
  assert.equal(preserveSgr(value), 'before\u009b31mred\u009b0m after')
})

test('snapshot replay preserves animation erasure and cursor movement, without device queries or app modes', () => {
  const animation = 'Generating\r\n\x1b[1A\x1b[2K\rDone\r\n'
  assert.equal(preserveSgr(animation, true), animation)
  assert.equal(preserveSgr('\x1b[6n\x1b[?1000h\x1b]52;c;secret\x07Done', true), 'Done')
  assert.equal(preserveSgr('\x1b7hello\x1b8world', true), '\x1b7hello\x1b8world')
  assert.equal(preserveSgr('\x1b7hello\x1b8world'), 'helloworld')
  assert.equal(preserveSgr('\u009b2KDone', true), '\u009b2KDone')
  assert.equal(preserveSgr('\x1b[c\u009b0cDone', true), 'Done')
  assert.equal(preserveSgr('\x1b=Hello\x1b>World', true), 'HelloWorld')
  assert.equal(preserveSgr('\x1b(BText', true), 'Text')
})
