import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { withScheme } from './sanitizeUrl.ts'

describe('withScheme', () => {
  test('gives a bare host the scheme it meant', () => {
    assert.equal(withScheme('example.com'), 'https://example.com')
    assert.equal(withScheme('www.example.com'), 'https://www.example.com')
    assert.equal(withScheme('sub.example.co.uk/path?q=1'), 'https://sub.example.co.uk/path?q=1')
    assert.equal(withScheme('localhost:5173'), 'https://localhost:5173')
  })

  test('leaves anything that already has a scheme alone', () => {
    assert.equal(withScheme('https://example.com'), 'https://example.com')
    assert.equal(withScheme('http://example.com'), 'http://example.com')
    assert.equal(withScheme('mailto:a@b.com'), 'mailto:a@b.com')
    assert.equal(withScheme('javascript:alert(1)'), 'javascript:alert(1)')
  })

  test('leaves paths alone', () => {
    assert.equal(withScheme('/usr/local/bin'), '/usr/local/bin')
    assert.equal(withScheme('./relative/file'), './relative/file')
    assert.equal(withScheme('#anchor'), '#anchor')
    assert.equal(withScheme('C:\\Users\\me\\notes.txt'), 'C:\\Users\\me\\notes.txt')
    assert.equal(withScheme('folder\\file.txt'), 'folder\\file.txt')
  })

  // The field accepts "URL or path", so a lone dotted word is ambiguous.
  // Turning report.pdf into a web address would be worse than leaving it.
  test('does not turn a bare file name into a web address', () => {
    assert.equal(withScheme('report.pdf'), 'report.pdf')
    assert.equal(withScheme('notes.txt'), 'notes.txt')
    assert.equal(withScheme('build.sh'), 'build.sh')
    assert.equal(withScheme('index.tsx'), 'index.tsx')
  })

  test('a path or an explicit www. still wins over the file-name guard', () => {
    assert.equal(withScheme('example.com/report.pdf'), 'https://example.com/report.pdf')
    assert.equal(withScheme('www.notes.txt'), 'https://www.notes.txt')
  })

  test('passes through what it cannot classify', () => {
    assert.equal(withScheme(''), '')
    assert.equal(withScheme('not a url'), 'not a url')
    assert.equal(withScheme('singleword'), 'singleword')
  })
})
