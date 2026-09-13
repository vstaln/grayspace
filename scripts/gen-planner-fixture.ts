#!/usr/bin/env node
// Golden fixture for the planner half of block 2: journal entries and the item
// list the real PlannerStore.reduce folds them into.
//
// Date.now and the local day are pinned, because "today"/"tomorrow" resolve
// against the calendar and the revive path falls back to the clock.
//
// Regenerate with:  node scripts/gen-planner-fixture.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlannerStore, type PlanItem } from '../src/main/plannerStore.ts'
import type { JournalEntry } from '../src/main/core/index.ts'

const FIXED_NOW = new Date(2026, 8, 13, 12, 0, 0).getTime()
const realNow = Date.now
Date.now = () => FIXED_NOW

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TODAY = localDayKey(new Date(FIXED_NOW))

let seq = 0
function entry(
  type: string,
  target: string,
  payload: unknown,
  options: { version?: number; phase?: string; actorId?: string } = {}
): JournalEntry {
  seq += 1
  return {
    seq,
    at: 1789061000000 + seq * 1000,
    phase: (options.phase ?? 'commit') as JournalEntry['phase'],
    actorId: options.actorId ?? 'user',
    type,
    target,
    payload,
    ...(options.version !== undefined ? { version: options.version } : {}),
    prevHash: '',
    hash: ''
  } as JournalEntry
}

const entries: JournalEntry[] = [
  entry('plan.create', 'plan:p1', { title: 'Write the report', order: 1 }, { version: 1 }),
  entry('plan.create', 'plan:new', { id: 'p2', title: 'Review the diff', note: 'careful' }, { version: 1 }),
  entry('plan.create', 'plan:new', { title: 'Minted id' }, { version: 1 }),

  // Dropped: no title.
  entry('plan.create', 'plan:p4', { note: 'orphan' }, { version: 1 }),
  // Dropped: not a commit.
  entry('plan.create', 'plan:p5', { title: 'Never' }, { phase: 'intent' }),

  // Relative days resolve against the local calendar.
  entry('plan.create', 'plan:p6', { title: 'Due today', day: 'today', time: '09:30' }, { version: 1 }),
  entry('plan.create', 'plan:p7', { title: 'Due tomorrow', day: 'tomorrow' }, { version: 1 }),
  // An invalid day on create is swallowed by the forgiving validator.
  entry('plan.create', 'plan:p8', { title: 'Bad day', day: 'not-a-date' }, { version: 1 }),
  // An invalid time is simply dropped.
  entry('plan.create', 'plan:p9', { title: 'Bad time', time: '99:99' }, { version: 1 }),

  // order is read with Number.isFinite, which does not coerce: "5" is not 5.
  entry('plan.create', 'plan:p10', { title: 'String order', order: '5' }, { version: 1 }),

  // Updates.
  entry('plan.update', 'plan:p1', { title: '  Renamed  ', note: 'now with a note' }, { version: 4 }),
  entry('plan.update', 'plan:p1', { done: true }),
  entry('plan.update', 'plan:p1', { project: '  work  ' }, { version: 6 }),
  entry('plan.update', 'plan:p1', { project: null }, { version: 7 }),
  entry('plan.update', 'plan:p1', { day: '2026-1-5' }, { version: 8 }),
  entry('plan.update', 'plan:missing', { title: 'nobody' }, { version: 9 }),
  // A blank title leaves the existing one alone.
  entry('plan.update', 'plan:p2', { title: '   ' }, { version: 3 }),

  // Attachments, including the empty list that must drop the key entirely.
  entry('plan.update', 'plan:p2', { attachments: ['a.png', ' b.png ', '', 'c.png'] }, { version: 4 }),
  entry('plan.update', 'plan:p2', { attachments: [] }, { version: 5 }),

  // Toggle: explicit and implicit.
  entry('plan.toggle', 'plan:p6', { done: true }, { version: 2 }),
  entry('plan.toggle', 'plan:p6', {}),
  entry('plan.toggle', 'plan:gone', {}, { version: 3 }),

  entry('plan.delete', 'plan:p9', {}, { version: 2 }),
  entry('plan.delete', 'plan:never-existed', {}, { version: 2 }),

  entry('plan.teleport', 'plan:p1', {}, { version: 99 })
]

let state = new Map<string, PlanItem>()
for (const event of entries) state = PlannerStore.reduce(state, event)

Date.now = realNow

const outFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'native',
  'orcspace-app',
  'tests',
  'fixtures',
  'planner-projection.json'
)
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(
  outFile,
  JSON.stringify({ today: TODAY, entries, items: Array.from(state.values()) }, null, 2) + '\n',
  'utf8'
)

console.log(`Wrote ${entries.length} entries and ${state.size} items (today = ${TODAY})`)
console.log(`  ${outFile}`)
