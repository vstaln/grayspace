import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { presenceLeaksSecrets } from './linkSnapshot.ts'

import { writeRuntimePresence, clearRuntimePresence, readRuntimePresence, runtimeFile } from './runtimePresence.ts'

describe('runtimePresence', () => {
  test('writes a discoverable beacon without secrets and clears it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-runtime-'))
    const previous = process.env.ORCSPACE_TEST_USER_DATA
    process.env.ORCSPACE_TEST_USER_DATA = dir
    try {
      const file = writeRuntimePresence({ mcpRunning: true, workspaceDir: dir })
      assert.equal(file, runtimeFile())
      const read = readRuntimePresence()
      assert.ok(read)
      assert.equal(read.app, 'orcspace')
      assert.equal(read.workspaceDir, dir)
      assert.ok(typeof read.writtenAt === 'number')
      assert.deepEqual(presenceLeaksSecrets(read), [])
      clearRuntimePresence()
      assert.equal(readRuntimePresence(), null)
      clearRuntimePresence()
    } finally {
      if (previous === undefined) delete process.env.ORCSPACE_TEST_USER_DATA
      else process.env.ORCSPACE_TEST_USER_DATA = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
