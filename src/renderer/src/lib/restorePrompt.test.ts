import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  defaultChoice,
  needsRestorePrompt,
  restoreRowTitle,
  splitRestore,
  startsAgent
} from './restorePrompt.ts'

const agent = (id: string, command: string, label = id): { id: string; label: string; command: string } => ({
  id,
  label,
  command
})

const MICHAEL = { id: 'code-1', agent: agent('antigravity', 'agy --conversation aaa', 'Antigravity'), title: 'Michael' }
const HUGO = { id: 'code-2', agent: agent('antigravity', 'agy --conversation bbb', 'Antigravity'), title: 'Hugo' }
const CLAUDE = { id: 'code-3', agent: agent('claude', 'claude --resume ccc', 'Claude Code') }
const BROWSER = { id: 'code-4', agent: agent('browser', 'browser', 'Browser') }

describe('restorePrompt - what is worth asking about', () => {
  test('a terminal that would start a CLI is', () => {
    assert.equal(startsAgent(MICHAEL), true)
    assert.equal(needsRestorePrompt([MICHAEL, BROWSER]), true)
  })

  test('a browser session is not, and neither is an empty board', () => {
    assert.equal(startsAgent(BROWSER), false)
    assert.equal(needsRestorePrompt([BROWSER]), false)
    assert.equal(needsRestorePrompt([]), false)
  })

  test('a session with no command to run is not', () => {
    assert.equal(startsAgent({ id: 'code-9', agent: agent('custom', '   ') }), false)
  })

  test('everything that would start is ticked to begin with', () => {
    assert.deepEqual(
      Array.from(defaultChoice([MICHAEL, HUGO, BROWSER])),
      ['code-1', 'code-2']
    )
  })
})

describe('restorePrompt - splitting the board', () => {
  const board = [MICHAEL, HUGO, CLAUDE, BROWSER]

  test('only the ticked terminals start', () => {
    const { start, drop } = splitRestore(board, new Set(['code-1', 'code-3']))
    assert.deepEqual(start.map((s) => s.id), ['code-1', 'code-3', 'code-4'])
    assert.deepEqual(drop.map((s) => s.id), ['code-2'])
  })

  test('the order of the board is kept', () => {
    const { start } = splitRestore(board, new Set(['code-3', 'code-1']))
    assert.deepEqual(start.map((s) => s.id), ['code-1', 'code-3', 'code-4'])
  })

  test('ticking nothing drops the board, browser included', () => {
    const { start, drop } = splitRestore(board, new Set())
    assert.deepEqual(start, [])
    assert.deepEqual(drop.map((s) => s.id), ['code-1', 'code-2', 'code-3', 'code-4'])
  })

  test('a browser session rides along with anything kept', () => {
    const { start } = splitRestore([BROWSER, MICHAEL], new Set(['code-1']))
    assert.deepEqual(start.map((s) => s.id), ['code-4', 'code-1'])
  })

  test('an id for a session that is not there changes nothing', () => {
    const { start } = splitRestore(board, new Set(['code-1', 'code-gone']))
    assert.deepEqual(start.map((s) => s.id), ['code-1', 'code-4'])
  })
})

describe('restorePrompt - how a row reads', () => {
  test('the name the user gave the terminal wins', () => {
    assert.equal(restoreRowTitle(MICHAEL), 'Michael')
  })

  test('an unnamed terminal falls back to its agent', () => {
    assert.equal(restoreRowTitle(CLAUDE), 'Claude Code')
    assert.equal(restoreRowTitle({ ...MICHAEL, title: '   ' }), 'Antigravity')
  })
})
