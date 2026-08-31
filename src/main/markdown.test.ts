import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { renderMarkdownSafe, renderMarkdownInlineLinks, extractSafeLinks } from '../renderer/src/lib/markdown.ts'

describe('renderMarkdownSafe — markdown rendering and security', () => {
  test('renders basic formatting without double-escaping', () => {
    const input = '**Tom & Jerry**'
    const output = renderMarkdownSafe(input)
    assert.equal(output, '<strong>Tom &amp; Jerry</strong>')
  })

  test('renders italic and code formatting with entities intact', () => {
    const input = '*A < B* and `C > D`'
    const output = renderMarkdownSafe(input)
    assert.equal(output, '<em>A &lt; B</em> and <code>C &gt; D</code>')
  })

  test('sanitizes unsafe javascript URLs in links', () => {
    const input = '[Click me](javascript:alert(1))'
    const output = renderMarkdownSafe(input)
    assert.equal(output, 'Click me')
  })

  test('allows safe https and http links with target="_blank"', () => {
    const input = '[OrcSpace](https://orcspace.dev)'
    const output = renderMarkdownSafe(input)
    assert.equal(
      output,
      '<a href="https://orcspace.dev" target="_blank" rel="noreferrer noopener">OrcSpace</a>'
    )
  })

  test('extracts safe links correctly', () => {
    const input = '[Good](https://example.com) and [Bad](javascript:void(0))'
    const safe = extractSafeLinks(input)
    assert.deepEqual(safe, ['https://example.com'])
  })

  test('handles URLs with balanced parentheses like Wikipedia', () => {
    const input = '[Python](https://en.wikipedia.org/wiki/Python_(programming_language))'
    const output = renderMarkdownSafe(input)
    assert.equal(
      output,
      '<a href="https://en.wikipedia.org/wiki/Python_(programming_language)" target="_blank" rel="noreferrer noopener">Python</a>'
    )
  })

  test('renders safe images with loading="lazy"', () => {
    const input = '![Logo](https://example.com/logo.png)'
    const output = renderMarkdownSafe(input)
    assert.equal(output, '<img src="https://example.com/logo.png" alt="Logo" loading="lazy" />')
  })

  test('sanitizes unsafe image sources to alt text', () => {
    const input = '![Exploit](javascript:alert(1))'
    const output = renderMarkdownSafe(input)
    assert.equal(output, 'Exploit')
  })

  test('escapes raw HTML tags', () => {
    const input = '<script>alert(1)</script>'
    const output = renderMarkdownSafe(input)
    assert.equal(output, '&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('handles newlines as <br />', () => {
    const input = 'Line 1\nLine 2'
    const output = renderMarkdownSafe(input)
    assert.equal(output, 'Line 1<br />Line 2')
  })
})
