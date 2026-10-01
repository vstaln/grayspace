import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-notes-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

const { NotesStore } = await import('./notesStore.ts')

after(() => {
  delete process.env.ORCSPACE_TEST_USER_DATA
  fs.rmSync(userData, { recursive: true, force: true })
})

test('notes and category colors persist across store reloads', () => {
  const first = new NotesStore()
  const note = first.createItem({
    title: 'Release checklist',
    body: 'Keep this note after restart.',
    tags: ['Release', 'Build'],
    category: 'Engineering',
    createdBy: 'user'
  })
  first.setCategoryColor('Engineering', '#234567')
  first.updateItem(note.id, { body: 'Updated before restart.' })
  first.dispose()

  const restored = new NotesStore()
  const saved = restored.get(note.id)
  assert.ok(saved)
  assert.equal(saved.title, 'Release checklist')
  assert.equal(saved.body, 'Updated before restart.')
  assert.deepEqual(saved.tags, ['release', 'build'])
  assert.equal(saved.category, 'Engineering')
  assert.equal(saved.color, '#234567')
  assert.equal(restored.snapshot().categoryColors.Engineering, '#234567')
  restored.dispose()
})
