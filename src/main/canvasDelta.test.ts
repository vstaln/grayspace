import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

process.env.ORCSPACE_TEST_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'orcspace-canvas-delta-test-'))

import { CanvasStore } from './canvasState.ts'

describe('Canvas Delta Patching and Fine-Grained Widget Versioning', () => {
  test('patchWidget and patchWidgets bump individual widget versions without corrupting canvas', () => {
    const store = new CanvasStore()

    const w1 = store.putWidget({ id: 'w1', title: 'Terminal 1', x: 0, y: 0, w: 400, h: 300, z: 1 })
    const w2 = store.putWidget({ id: 'w2', title: 'Note 1', x: 500, y: 0, w: 300, h: 400, z: 2 })

    assert.equal(w1.version, 1)
    assert.equal(w2.version, 1)


    const patchedW1 = store.patchWidget('w1', { x: 50, y: 80 })
    assert.equal(patchedW1.version, 2)
    assert.equal(patchedW1.x, 50)
    assert.equal(patchedW1.y, 80)


    assert.equal(store.widget('w2')?.version, 1)


    const multiPatched = store.patchWidgets([
      { id: 'w1', patch: { z: 3 } },
      { id: 'w2', patch: { z: 4 } }
    ])

    assert.equal(multiPatched.length, 2)
    assert.equal(store.widget('w1')?.version, 3)
    assert.equal(store.widget('w2')?.version, 2)
  })
})
