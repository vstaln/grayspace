import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { LockManager } from './core/locks.ts'
import { TaskLockManager } from './taskLockManager.ts'
import type { Task } from './coordination.ts'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test',
    brief: '',
    files: ['src/a.ts'],
    state: 'in_progress',
    createdBy: 'user',
    tags: [],
    maxSteps: 20,
    maxReviewIterations: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
    assignee: 'worker-1',
    ...overrides
  }
}

describe('TaskLockManager', () => {
  let locks: LockManager
  let mgr: TaskLockManager
  beforeEach(() => {
    locks = new LockManager({ now: () => Date.now() })
    mgr = new TaskLockManager(locks)
  })

  it('acquireForTask acquires all files', () => {
    mgr.acquireForTask('task-1', ['a.ts', 'b.ts'], 'alice')
    assert.ok(locks.isHeldBy('file:a.ts' as never, 'alice'))
    assert.ok(locks.isHeldBy('file:b.ts' as never, 'alice'))
  })

  it('acquireForTask rolls back on conflict', () => {
    locks.acquire({ resource: 'file:b.ts' as never, actorId: 'bob', ttlMs: 60000, reason: 'other' })
    assert.throws(() => mgr.acquireForTask('task-1', ['a.ts', 'b.ts'], 'alice'))
    // a.ts should have been released
    assert.equal(locks.isHeldBy('file:a.ts' as never, 'alice'), false)
  })

  it('renewForTask renews held locks', () => {
    locks.acquire({ resource: 'file:src/a.ts' as never, actorId: 'worker-1', ttlMs: 1000, reason: 'task task-1' })
    const before = locks.holder('file:src/a.ts' as never)!.expiresAt
    mgr.renewForTask(makeTask())
    const after = locks.holder('file:src/a.ts' as never)!.expiresAt
    assert.ok(after > before)
  })

  it('releaseForTask releases only matching reason', () => {
    locks.acquire({ resource: 'file:src/a.ts' as never, actorId: 'worker-1', ttlMs: 60000, reason: 'task task-1' })
    locks.acquire({ resource: 'file:src/b.ts' as never, actorId: 'worker-1', ttlMs: 60000, reason: 'other' })
    mgr.releaseForTask(makeTask({ files: ['src/a.ts', 'src/b.ts'] }))
    assert.equal(locks.holder('file:src/a.ts' as never), undefined)
    assert.ok(locks.holder('file:src/b.ts' as never))
  })

  it('isTaskLocksHeld detects held lock', () => {
    const task = makeTask({ files: ['src/a.ts'] })
    assert.equal(mgr.isTaskLocksHeld(task, 'worker-1'), false)
    locks.acquire({ resource: 'file:src/a.ts' as never, actorId: 'worker-1', ttlMs: 60000, reason: 'task task-1' })
    assert.equal(mgr.isTaskLocksHeld(task, 'worker-1'), true)
  })

  it('assertCanLock forbids non-manager non-assignee', () => {
    const task = makeTask()
    assert.throws(() => mgr.assertCanLock(task, 'evil', () => false))
    assert.doesNotThrow(() => mgr.assertCanLock(task, 'worker-1', () => false))
    assert.doesNotThrow(() => mgr.assertCanLock(task, 'manager', (m) => m === 'manager'))
  })
})
