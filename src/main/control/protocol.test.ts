import assert from 'node:assert/strict'
import test from 'node:test'
import { clampInt, localDayKey, normalizeLockResource, safeDecode, shiftLocalDay } from './protocol.ts'

test('control protocol helpers normalize bounded query values', () => {
  assert.equal(clampInt('9.8', 2, 1, 8), 8)
  assert.equal(clampInt('not-a-number', 2, 1, 8), 2)
  assert.equal(safeDecode('hello%20world'), 'hello world')
  assert.equal(safeDecode('%E0%A4%A'), null)
})

test('control protocol normalizes lock paths to file resources', () => {
  assert.equal(normalizeLockResource('file:C:\\Work\\Repo'), 'file:C:/work/repo')
  assert.equal(normalizeLockResource('terminal:alice'), 'terminal:alice')
})

test('local day helpers use local calendar boundaries', () => {
  const date = new Date(2026, 0, 31, 23, 59)
  assert.equal(localDayKey(date), '2026-01-31')
  assert.equal(shiftLocalDay(localDayKey(date), 1), '2026-02-01')
})
