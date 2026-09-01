import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Pure renderer libs — tested from main so they run in the existing
// `npm test` (node:test) without a jsdom / vitest harness.
import { isSafeUrl, sanitizeUrl, safeHref } from '../renderer/src/lib/sanitizeUrl.ts'
import { renderMarkdownInlineLinks, renderMarkdownSafe, extractSafeLinks } from '../renderer/src/lib/markdown.ts'
import { DRAW_CLICK_THRESHOLD_PX } from '../renderer/src/lib/canvasMetrics.ts'

describe('sanitizeUrl', () => {
  it('allows http/https', () => {
    assert.equal(isSafeUrl('https://example.com'), true)
    assert.equal(isSafeUrl('http://example.com/path?q=1'), true)
  })
  it('blocks javascript: and data:', () => {
    assert.equal(isSafeUrl('javascript:alert(1)'), false)
    assert.equal(isSafeUrl('  javascript:alert(1)'), false)
    assert.equal(isSafeUrl('data:text/html,hi'), false)
    assert.equal(isSafeUrl('vbscript:msg'), false)
  })
  it('allows relative and fragments', () => {
    assert.equal(isSafeUrl('/path'), true)
    assert.equal(isSafeUrl('#anchor'), true)
    assert.equal(isSafeUrl('./relative'), true)
  })
  it('sanitizeUrl returns fallback on unsafe', () => {
    assert.equal(sanitizeUrl('javascript:alert(1)', null), null)
    assert.equal(sanitizeUrl('https://safe.com', null), 'https://safe.com')
  })
  it('safeHref mirrors sanitizeUrl', () => {
    assert.equal(safeHref('https://a.b'), 'https://a.b')
    assert.equal(safeHref('javascript:x'), null)
  })
  it('blocks obfuscated whitespace javascript', () => {
    assert.equal(isSafeUrl('  java\tscript:alert(1)'), false)
  })
})

describe('markdown', () => {
  it('renders safe link', () => {
    const html = renderMarkdownInlineLinks('[hi](https://example.com)')
    assert.match(html, /<a href="https:\/\/example\.com"/)
  })
  it('strips unsafe link to text', () => {
    const html = renderMarkdownInlineLinks('[hi](javascript:alert(1))')
    assert.equal(html.includes('<a'), false)
    assert.match(html, /hi/)
  })
  it('renders image safely', () => {
    const html = renderMarkdownInlineLinks('![alt](https://example.com/x.png)')
    assert.match(html, /<img/)
  })
  it('strips unsafe image', () => {
    const html = renderMarkdownInlineLinks('![alt](javascript:alert(1))')
    assert.equal(html.includes('<img'), false)
  })
  it('renderMarkdownSafe handles bold and code', () => {
    const html = renderMarkdownSafe('**bold** and `code`')
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<code>code<\/code>/)
  })
  it('extractSafeLinks filters unsafe', () => {
    assert.deepEqual(extractSafeLinks('[a](https://a.b) [b](javascript:x)'), ['https://a.b'])
  })
})

describe('canvasMetrics', () => {
  it('DRAW_CLICK_THRESHOLD_PX is stable', () => {
    assert.equal(DRAW_CLICK_THRESHOLD_PX, 4)
    assert.ok(Number.isFinite(DRAW_CLICK_THRESHOLD_PX))
  })
})
