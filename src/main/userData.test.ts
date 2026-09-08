import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { getUserDataDir } from './userData.ts'

describe('userData - getUserDataDir', () => {
  test('returns test path when ORCSPACE_TEST_USER_DATA is set', () => {
    const testDir = '/tmp/test-orcspace-data'
    ;(process as any).env.ORCSPACE_TEST_USER_DATA = testDir
    const result = getUserDataDir()
    assert.equal(result, testDir)
    delete (process as any).env.ORCSPACE_TEST_USER_DATA
  })

  test('throws when Electron app unavailable and no test env', () => {

    delete (process as any).env.ORCSPACE_TEST_USER_DATA
    let threw = false
    try {
      getUserDataDir()
    } catch (err) {
      threw = true
      assert.ok(err instanceof Error)
      assert.ok(err.message.includes('Electron app is unavailable'))
    }
    assert.ok(threw, 'should have thrown')
  })
})
