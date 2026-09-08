import test from 'node:test'
import assert from 'node:assert/strict'
import { preserveSgr } from './ansi.ts'

test('ANSI sanitizers remove C1 control sequences without losing visible text', () => {
  const value = `before\u009d52;c;secret\u009c\u0090private\u009c\u009b31mred\u009b0m after`
  assert.equal(preserveSgr(value), 'before\u009b31mred\u009b0m after')
})
