#!/usr/bin/env node
// Emits the golden fixture for block 2: a run of journal entries and the canvas
// snapshot the real TypeScript reducer folds them into.
//
// Every branch of CanvasStore.reduce is exercised, including the ones that only
// matter on replay — a widget kind this build does not know, an arc recorded
// twice, an arc left dangling by a removal, a camera zoom outside its clamp.
//
// Date.now is pinned for the run: the sanitizers fall back to it for missing
// updatedAt/bornAt fields, which would otherwise make the fixture differ on
// every generation and hide a real divergence behind the noise.
//
// Regenerate with:  node scripts/gen-projection-fixture.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CanvasStore, type CanvasDataState } from '../src/main/canvasState.ts'
import type { JournalEntry } from '../src/main/core/index.ts'

const FIXED_NOW = 1789000000000
const realNow = Date.now
Date.now = () => FIXED_NOW

let seq = 0
function entry(
  type: string,
  target: string,
  payload: unknown,
  options: { version?: number; phase?: string; at?: number } = {}
): JournalEntry {
  seq += 1
  return {
    seq,
    at: options.at ?? 1789061000000 + seq * 1000,
    phase: (options.phase ?? 'commit') as JournalEntry['phase'],
    actorId: 'user',
    type,
    target,
    payload,
    ...(options.version !== undefined ? { version: options.version } : {}),
    prevHash: '',
    hash: ''
  } as JournalEntry
}

const widget = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Widget ${id}`,
  kind: 'terminal',
  x: 100.5,
  y: -200.25,
  w: 620,
  h: 380,
  z: 1,
  ...extra
})

const entries: JournalEntry[] = [
  // Creation, including the "new" target that has to mint an id.
  entry('widget.create', 'widget:w1', widget('ignored-id'), { version: 1 }),
  entry('widget.create', 'widget:new', widget('w2'), { version: 1 }),
  entry('widget.create', 'widget:new', { ...widget('x'), id: undefined }, { version: 1 }),

  // A phase that is not a commit must change nothing.
  entry('widget.create', 'widget:never', widget('never'), { phase: 'intent' }),

  // A kind this build does not know is rejected outright, not defaulted.
  entry('widget.create', 'widget:w4', widget('w4', { kind: 'hologram' }), { version: 1 }),

  // Missing required geometry is rejected.
  entry('widget.create', 'widget:w5', { id: 'w5', title: 'No geometry' }, { version: 1 }),

  // Updates: a patch, a version-less patch (which increments), and a patch to
  // a widget that is not there (which does nothing).
  entry('widget.update', 'widget:w1', { x: 999.125, title: 'Renamed' }, { version: 5 }),
  entry('widget.update', 'widget:w1', { y: 42 }),
  entry('widget.update', 'widget:ghost', { x: 1 }, { version: 2 }),
  entry('widget.update', 'widget:w1', { maximized: true }, { version: 7 }),

  // Camera, including a zoom outside the 0.2..4 clamp and a malformed one.
  entry('canvas.camera', 'canvas:main', { x: -4617.767343849823, y: -758.4946652788749, zoom: 9 }, { version: 2 }),
  entry('canvas.camera', 'canvas:main', { x: 1, y: 2, zoom: 0.01 }, { version: 3 }),
  entry('canvas.camera', 'canvas:main', { x: 'nope', y: 2, zoom: 1 }, { version: 4 }),

  // Strokes: a good one, a one-point one (dropped), a malformed one.
  entry('canvas.strokes', 'canvas:main', {
    strokes: [
      { id: 's1', color: '#ff0000', points: [{ x: 0, y: 0 }, { x: 1.5, y: 2.25 }, { x: 3, y: 4 }] },
      { id: 's2', color: '#00ff00', points: [{ x: 0, y: 0 }] },
      { id: 's3', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }
    ]
  }, { version: 5 }),

  // Connections: a live one, a self-link, a duplicate pair with a different id,
  // and one pointing at a widget that does not exist.
  entry('canvas.connections', 'canvas:main', {
    connections: [
      { id: 'c1', from: 'w1', to: 'w2', bornAt: 1789060000000 },
      { id: 'c2', from: 'w1', to: 'w1' },
      { id: 'c3', from: 'w1', to: 'w2' },
      { id: 'c4', from: 'w1', to: 'nowhere' }
    ]
  }, { version: 6 }),

  // Import: widgets plus an arc to one of them in the same payload.
  entry('canvas.import', 'canvas:main', {
    widgets: [widget('w6', { z: 3 }), widget('w7', { z: 4 })],
    camera: { x: 10, y: 20, zoom: 2 },
    connections: [{ id: 'c5', from: 'w6', to: 'w7', bornAt: 1789060000001 }]
  }, { version: 7 }),

  // Removing a widget drops the arcs that pointed at it.
  entry('widget.remove', 'widget:w7', {}, { version: 8 }),

  // An unknown command type leaves the state alone.
  entry('canvas.teleport', 'canvas:main', { x: 1 }, { version: 9 })
]

const initial: CanvasDataState = {
  widgets: new Map(),
  camera: { x: 0, y: 0, zoom: 1 },
  strokes: [],
  connections: [],
  version: 1
}

let state = initial
for (const event of entries) state = CanvasStore.reduce(state, event)

const snapshot = {
  widgets: Array.from(state.widgets.values()),
  camera: state.camera,
  strokes: state.strokes,
  connections: state.connections,
  version: state.version
}

Date.now = realNow

const outFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'native',
  'orcspace-app',
  'tests',
  'fixtures',
  'canvas-projection.json'
)
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(
  outFile,
  JSON.stringify({ fixedNow: FIXED_NOW, entries, snapshot }, null, 2) + '\n',
  'utf8'
)

console.log(`Wrote ${entries.length} entries and a ${snapshot.widgets.length}-widget snapshot`)
console.log(`  ${outFile}`)
