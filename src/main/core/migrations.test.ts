import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { MigrationRunner, type Migration } from './migrations.ts'

describe('Bidirectional Schema Migrations as Code', () => {
  interface CanvasV1 {
    items: Array<{ id: string; name: string }>
  }
  interface CanvasV2 {
    widgets: Array<{ id: string; title: string; version: number }>
  }

  const canvasMigrations: Migration[] = [
    {
      version: 2,
      name: 'v1_to_v2_rename_items_to_widgets',
      up: (data: unknown) => {
        const v1 = data as CanvasV1
        return {
          widgets: (v1.items || []).map((it) => ({
            id: it.id,
            title: it.name,
            version: 1
          }))
        }
      },
      down: (data: unknown) => {
        const v2 = data as CanvasV2
        return {
          items: (v2.widgets || []).map((w) => ({
            id: w.id,
            name: w.title
          }))
        }
      }
    }
  ]

  test('migrates schema up and down correctly in-memory', () => {
    const v1Data: CanvasV1 = { items: [{ id: 'w1', name: 'Terminal Widget' }] }

    // Migrate UP (v1 -> v2)
    const upRes = MigrationRunner.migrateData<CanvasV2>(v1Data, 1, 2, canvasMigrations)
    assert.equal(upRes.finalVersion, 2)
    assert.equal(upRes.stepsApplied, 1)
    assert.deepEqual(upRes.data.widgets, [{ id: 'w1', title: 'Terminal Widget', version: 1 }])

    // Migrate DOWN (v2 -> v1)
    const downRes = MigrationRunner.migrateData<CanvasV1>(upRes.data, 2, 1, canvasMigrations)
    assert.equal(downRes.finalVersion, 1)
    assert.equal(downRes.stepsApplied, 1)
    assert.deepEqual(downRes.data.items, [{ id: 'w1', name: 'Terminal Widget' }])
  })
})
