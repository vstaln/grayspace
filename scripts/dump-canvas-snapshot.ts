#!/usr/bin/env node
// Folds a real command journal with the TypeScript canvas reducer and writes
// the resulting snapshot, so the Rust port can be compared against it on data
// the app actually produced rather than on data written to be compared.
//
// Step 0 of the migration established why this matters: a hand-built fixture
// passed on the first run while a real journal exposed a one-ULP float bug.
//
//   node scripts/dump-canvas-snapshot.ts <journal.ndjson> <out.json> [fixedNow]

import { readFileSync, writeFileSync } from 'node:fs'
import { CanvasStore, type CanvasDataState } from '../src/main/canvasState.ts'
import type { JournalEntry } from '../src/main/core/index.ts'

const [journalPath, outPath, fixedNowArg] = process.argv.slice(2)
if (!journalPath || !outPath) {
  console.error('usage: dump-canvas-snapshot.ts <journal.ndjson> <out.json> [fixedNow]')
  process.exit(2)
}

// Pinned so the sanitizers' missing-timestamp fallbacks are reproducible and
// the Rust side can be told which value to use.
const fixedNow = Number(fixedNowArg ?? 1789000000000)
Date.now = () => fixedNow

const entries: JournalEntry[] = readFileSync(journalPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as JournalEntry)

let state: CanvasDataState = {
  widgets: new Map(),
  camera: { x: 0, y: 0, zoom: 1 },
  strokes: [],
  connections: [],
  version: 1
}
for (const event of entries) state = CanvasStore.reduce(state, event)

writeFileSync(
  outPath,
  JSON.stringify(
    {
      fixedNow,
      entryCount: entries.length,
      snapshot: {
        widgets: Array.from(state.widgets.values()),
        camera: state.camera,
        strokes: state.strokes,
        connections: state.connections,
        version: state.version
      }
    },
    null,
    2
  ) + '\n',
  'utf8'
)

console.log(`folded ${entries.length} entries -> ${state.widgets.size} widgets, version ${state.version}`)
console.log(`  ${outPath}`)
