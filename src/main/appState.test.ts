import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'

const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-app-state-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

const { AppState } = await import('./appState.ts')

after(() => {
  delete process.env.ORCSPACE_TEST_USER_DATA
  fs.rmSync(userData, { recursive: true, force: true })
})

test('an explicitly cleared favorite terminal list survives reload', () => {
  const first = new AppState()
  first.patchSettings({ favoriteTerminalNames: ['Arthur', 'Henry'] })
  first.patchSettings({ favoriteTerminalNames: [] })
  first.dispose()

  const restored = new AppState()
  assert.deepEqual(restored.get().settings.favoriteTerminalNames, [])
  restored.dispose()
})
