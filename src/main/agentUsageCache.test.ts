import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJsonlHistory } from './agentUsage.ts'

for (const [key, duration] of [['requests5h', 5 * 3600000], ['requestsWeekly', 7 * 86400000], ['requestsMonthly', 30 * 86400000]] as const) {
  test(`${key} expires without a history file change`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-usage-review-'))
    const file = join(dir, 'history.jsonl')
    let now = 1800000000000
    t.mock.method(Date, 'now', () => now)
    try {
      writeFileSync(file, JSON.stringify({ timestamp: now - duration + 1000, tokens: 42 }) + '\n')
      assert.equal(parseJsonlHistory([file])[key], 1)
      now += 1001
      assert.equal(parseJsonlHistory([file])[key], 0)
    } finally {
      rmSync(file)
      rmdirSync(dir)
    }
  })
}
