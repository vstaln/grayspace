import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { isExternalOpenAllowed } from './navigationGuard.ts'
import { isTrustedAppNavigation } from './navigationGuard.ts'

const options = {
  devUrl: 'http://localhost:20222/',
  controlOrigin: 'http://127.0.0.1:20220/',
  rendererFile: 'C:/app/out/renderer/index.html'
}

describe('isTrustedAppNavigation', () => {
  test('accepts only exact trusted origins and the app protocol host', () => {
    assert.equal(isTrustedAppNavigation('http://localhost:20222/settings', options), true)
    assert.equal(isTrustedAppNavigation('http://127.0.0.1:20220/api', options), true)
    assert.equal(isTrustedAppNavigation('orc://app/index.html', options), true)
    assert.equal(isTrustedAppNavigation('orc://app.evil/index.html', options), false)
  })

  test('rejects hostname and path prefix confusion', () => {
    assert.equal(isTrustedAppNavigation('http://localhost:20222.evil/example', options), false)
    assert.equal(isTrustedAppNavigation('http://127.0.0.1:20220.evil/example', options), false)
    assert.equal(isTrustedAppNavigation('https://example.com/http://localhost:20222', options), false)
  })

  test('accepts only the exact packaged renderer file', () => {
    assert.equal(isTrustedAppNavigation('file:///C:/app/out/renderer/index.html', options), true)
    assert.equal(isTrustedAppNavigation('file:///C:/app/out/renderer/index.html.evil', options), false)
  })
})

describe('allowExternalOpen (Electron gold standard)', () => {
  test('allows https, denies dangerous schemes and credentials', () => {
    assert.equal(isExternalOpenAllowed('https://example.com/docs'), true)
    assert.equal(isExternalOpenAllowed('javascript:alert(1)'), false)
    assert.equal(isExternalOpenAllowed('file:///etc/passwd'), false)
    assert.equal(isExternalOpenAllowed('https://user:pass@example.com/'), false)
  })

  test('allows http only for loopback dev servers', () => {
    assert.equal(isExternalOpenAllowed('http://127.0.0.1:5174/'), true)
    assert.equal(isExternalOpenAllowed('http://localhost:3000/'), true)
    assert.equal(isExternalOpenAllowed('http://example.com/'), false)
  })
})
