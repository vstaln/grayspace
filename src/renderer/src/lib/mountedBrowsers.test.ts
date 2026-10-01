import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { isBrowserMounted, isCodeBrowserGuest, markBrowserMounted, markCodeBrowserGuest } from './mountedBrowsers.ts'

describe('mountedBrowsers', () => {
  test('tracks a browser from mount until its cleanup runs', () => {
    assert.equal(isBrowserMounted('code-1-1'), false)
    const unmount = markBrowserMounted('code-1-1')
    assert.equal(isBrowserMounted('code-1-1'), true)
    unmount()
    assert.equal(isBrowserMounted('code-1-1'), false)
  })
})

describe('code browser guests', () => {
  test('routes a popup only while its Code webview is mounted', () => {
    assert.equal(isCodeBrowserGuest(42), false)
    const unmount = markCodeBrowserGuest(42)
    assert.equal(isCodeBrowserGuest(42), true)
    assert.equal(isCodeBrowserGuest(43), false)
    unmount()
    assert.equal(isCodeBrowserGuest(42), false)
  })
})
