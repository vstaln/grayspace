import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ContentAddressedStore } from './cas.ts'

describe('Content-Addressed Storage (CAS)', () => {
  test('stores, retrieves and deduplicates immutable content by hash', () => {
    const cas = new ContentAddressedStore({ inMemory: true })

    const text = 'Plan execution output diff: lines +10 -2'
    const hash1 = cas.put(text)
    const hash2 = cas.put(text)


    assert.equal(hash1, hash2)
    assert.equal(cas.getText(hash1), text)
    assert.equal(cas.has(hash1), true)
    assert.equal(cas.stats().totalObjects, 1)


    const jsonObj = { planId: 'p1', steps: [1, 2, 3] }
    const jsonHash = cas.putJson(jsonObj)
    assert.deepEqual(cas.getJson(jsonHash), jsonObj)
    assert.equal(cas.stats().totalObjects, 2)


    const gcResult = cas.gc([hash1])
    assert.equal(gcResult.removed, 1)
    assert.equal(cas.has(jsonHash), false)
    assert.equal(cas.has(hash1), true)
  })
})
