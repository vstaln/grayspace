import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { terminalShowsLaunchFailure } from './orchestration.ts'

describe('worker launch diagnostics', () => {
  test('recognizes cmd and PowerShell command-not-found output', () => {
    assert.equal(
      terminalShowsLaunchFailure('"grok" is not recognized as an internal or external command', 'grok'),
      true
    )
    assert.equal(
      terminalShowsLaunchFailure('CategoryInfo: ObjectNotFound: (claude:String) [], CommandNotFoundException', 'claude'),
      true
    )
  })

  test('does not mistake ordinary agent output or an unrelated old error for a launch failure', () => {
    assert.equal(terminalShowsLaunchFailure('OpenCode ready', 'opencode'), false)
    assert.equal(terminalShowsLaunchFailure('grok: command not found', 'claude'), false)
  })
})
