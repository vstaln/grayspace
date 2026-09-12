import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getAgentUsageStats } from './agentUsage.ts'
import type { IpcDeps } from './ipc/types.ts'

describe('agentUsage - getAgentUsageStats', () => {
  it('returns structured agent usage statistics with 5h, weekly, and monthly limits', async () => {
    const mockDeps = {
      terminals: {
        list: () => [
          { id: 'term-1', title: 'Antigravity worker', alive: true },
          { id: 'term-2', title: 'codex session', alive: true },
          { id: 'term-3', title: 'opencode interpreter', alive: true },
          { id: 'term-4', title: 'zsh', alive: true }
        ],
        tailOutput: (id: string) => (id === 'term-1' ? 'agy session' : id === 'term-3' ? 'opencode interpreter v1.0' : '')
      }
    } as unknown as IpcDeps

    const stats = await getAgentUsageStats(mockDeps)
    assert.ok(Array.isArray(stats))
    assert.ok(stats.length >= 4)

    const agy = stats.find((a) => a.id === 'antigravity')
    const cdx = stats.find((a) => a.id === 'codex')
    const cld = stats.find((a) => a.id === 'claude')
    const opn = stats.find((a) => a.id === 'opencode')

    assert.ok(agy)
    assert.ok(cdx)
    assert.ok(cld)
    assert.ok(opn)


    assert.equal(agy.isOpen, true)
    assert.equal(cdx.isOpen, true)
    assert.equal(opn.isOpen, true)


    assert.ok(typeof agy.fiveHour.percent === 'number')
    assert.ok(typeof agy.fiveHour.requests === 'number')
    assert.ok(typeof agy.weekly.percent === 'number')
    assert.ok(typeof agy.weekly.requests === 'number')
    assert.ok(agy.monthly)
    assert.ok(typeof agy.monthly.percent === 'number')
    assert.ok(typeof agy.monthly.requests === 'number')

    assert.ok(opn.monthly)
    assert.ok(typeof opn.monthly.percent === 'number')
  })

  it('accurately parses and syncs exact live quota including monthly from terminal output', async () => {
    const sampleOutput = `
Models & Quota
Account: owendtatew@gmail.com

GEMINI MODELS
Models within this group: Gemini Flash, Gemini Pro

Weekly Limit Remaining
[\x1b[32m██████████████\x1b[0m░░░░░░░░░░] 59.01%
59% remaining · Refreshes in 133h 50m

Five Hour Limit Remaining
[\x1b[32m████████████████████\x1b[0m░░░░] 81.35%
(1-9 of 30 lines)

Monthly Limit Remaining: 92.40%
`

    const mockDeps = {
      terminals: {
        list: () => [{ id: 'term-agy', title: 'Antigravity CLI', alive: true }],
        tailOutput: () => sampleOutput
      }
    } as unknown as IpcDeps

    const stats = await getAgentUsageStats(mockDeps)
    const agy = stats.find((a) => a.id === 'antigravity')
    assert.ok(agy)

    assert.equal(agy.hasExactQuota, true)
    assert.equal(agy.fiveHour.remainingPercent, 81.35)
    assert.equal(agy.fiveHour.usedPercent, 18.65)
    assert.equal(agy.fiveHour.percent, 81.35)

    assert.equal(agy.weekly.remainingPercent, 59.01)
    assert.equal(agy.weekly.usedPercent, 40.99)
    assert.equal(agy.weekly.percent, 59.01)
    assert.equal(agy.weekly.resetInfo, 'Refreshes in 133h 50m')

    assert.ok(agy.monthly)
    assert.equal(agy.monthly.remainingPercent, 92.4)
    assert.equal(agy.monthly.usedPercent, 7.6)
  })
})
