import assert from 'node:assert/strict'
import test from 'node:test'
import { hostOf, toNavigationUrl } from './browserShared.ts'
import { IS_WINDOWS } from './platform.ts'

test('navigation rejects malformed explicit URLs', () => {
  assert.equal(toNavigationUrl('https://'), null)
  assert.equal(toNavigationUrl('https://%'), null)
})

test('navigation normalizes valid URLs and searches plain text', () => {
  assert.equal(toNavigationUrl('example.com'), 'https://example.com/')
  assert.equal(toNavigationUrl('localhost:3000'), 'http://localhost:3000/')
  assert.equal(toNavigationUrl('hello world'), 'https://www.google.com/search?q=hello%20world')
})

test('navigation accepts local files', () => {
  assert.equal(toNavigationUrl('file:///C:/Users/user/Desktop/ee/index.html'), 'file:///C:/Users/user/Desktop/ee/index.html')
  assert.equal(toNavigationUrl('C:\\Users\\user\\Desktop\\ee\\index.html'), 'file:///C:/Users/user/Desktop/ee/index.html')
  assert.equal(toNavigationUrl('C:/Users/user/a b.html'), 'file:///C:/Users/user/a%20b.html')
  assert.equal(toNavigationUrl('\\\\server\\share\\page.html'), 'file://server/share/page.html')
})

test('navigation still rejects script-bearing schemes', () => {
  assert.equal(toNavigationUrl('javascript:alert(1)'), null)
  assert.equal(toNavigationUrl('data:text/html,<b>x</b>'), null)
  assert.equal(toNavigationUrl('vbscript:msgbox'), null)
})

test('local file label falls back to the file name', () => {
  assert.equal(hostOf('file:///C:/Users/user/Desktop/ee/index.html'), 'index.html')
})

test('a POSIX absolute path is a local file only where such paths exist', () => {
  // On Windows there are no POSIX paths, and `/docs/index.html` is far more
  // likely to be a search than a file, so the branch is off there.
  assert.equal(
    toNavigationUrl('/Users/me/index.html'),
    IS_WINDOWS ? 'https://www.google.com/search?q=%2FUsers%2Fme%2Findex.html' : 'file:///Users/me/index.html'
  )
})

test('a bare slash word is always a search, on every platform', () => {
  assert.equal(toNavigationUrl('/word'), 'https://www.google.com/search?q=%2Fword')
})
