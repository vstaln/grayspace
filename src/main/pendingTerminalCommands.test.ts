import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearInitialCommand,
  markInitialCommandDelivered,
  peekInitialCommand,
  queueInitialCommand,
  queueInitialCommandOnce
} from '../renderer/src/lib/pendingTerminalCommands.ts'

describe('pendingTerminalCommands', () => {
  beforeEach(() => {
    for (const id of ['t1', 't2']) clearInitialCommand(id)
  })

  it('keeps a command queued until it is actually delivered', () => {
    queueInitialCommand('t1', 'opencode')

    // A widget generation that connects and is torn down before it types
    // anything must leave the command for the next one. This is the case that
    // left code sessions at a bare prompt: closing sibling sessions remounts
    // the survivors, and the command used to be consumed on connect.
    assert.equal(peekInitialCommand('t1'), 'opencode')
    assert.equal(peekInitialCommand('t1'), 'opencode')

    markInitialCommandDelivered('t1')
    assert.equal(peekInitialCommand('t1'), undefined)
  })

  it('refuses to re-queue a delivered command from a bulk state re-queue', () => {
    queueInitialCommand('t1', 'opencode')
    markInitialCommandDelivered('t1')

    // Persisted-state broadcasts re-queue every active session, and cannot
    // tell one restored from disk from one already running.
    queueInitialCommandOnce('t1', 'opencode')
    assert.equal(peekInitialCommand('t1'), undefined)
  })

  it('still queues an explicit relaunch after a delivery', () => {
    queueInitialCommand('t1', 'opencode')
    markInitialCommandDelivered('t1')

    // Choosing a different agent, or retrying a launch the pty was not ready
    // for, is a new request from the user rather than a replayed one.
    queueInitialCommand('t1', 'claude')
    assert.equal(peekInitialCommand('t1'), 'claude')
  })

  it('forgets a closed terminal entirely', () => {
    queueInitialCommand('t1', 'opencode')
    markInitialCommandDelivered('t1')
    clearInitialCommand('t1')

    // The id is gone for good, so nothing is owed and nothing is remembered.
    assert.equal(peekInitialCommand('t1'), undefined)
    queueInitialCommandOnce('t1', 'opencode')
    assert.equal(peekInitialCommand('t1'), 'opencode')
  })

  it('does not let one terminal consume another terminal command', () => {
    queueInitialCommand('t1', 'opencode')
    queueInitialCommand('t2', 'claude')
    markInitialCommandDelivered('t1')

    assert.equal(peekInitialCommand('t1'), undefined)
    assert.equal(peekInitialCommand('t2'), 'claude')
  })
})
