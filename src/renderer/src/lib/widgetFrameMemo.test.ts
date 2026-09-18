import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../components/WidgetFrame.tsx', import.meta.url)),
  'utf8'
)

/**
 * `WidgetFrame` is the only memoized component in the app with a hand-written
 * comparator, and it is hand-written because the default shallow compare
 * re-renders every widget on every canvas change — a terminal repaint per
 * pointer packet.
 *
 * The cost of that is a trap: a prop added to `Props` and not to the
 * comparator is simply never noticed by the memo, so the widget keeps
 * rendering the old value. Nothing fails, nothing warns, and the symptom is a
 * stale header or a card that will not react — the hardest kind of bug to
 * trace back to its cause. So the two lists are compared here instead.
 */
function propNames(): string[] {
  const block = /interface Props \{([\s\S]*?)\n\}/.exec(source)
  assert.ok(block, 'WidgetFrame no longer declares an interface named Props')
  return block[1]
    .split('\n')
    .map((line) => /^\s*([A-Za-z_$][\w$]*)\??:/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
}

function comparatorBody(): string {
  const fn = /function areWidgetFramePropsEqual\([\s\S]*?\n\}/.exec(source)
  assert.ok(fn, 'WidgetFrame no longer declares areWidgetFramePropsEqual')
  return fn[0]
}

describe('WidgetFrame memo comparator', () => {
  it('is still what React.memo is given', () => {
    assert.match(source, /React\.memo\(WidgetFrame,\s*areWidgetFramePropsEqual\)/)
  })

  it('compares every prop the component declares', () => {
    const body = comparatorBody()
    const names = propNames()
    assert.ok(names.length > 5, 'parsed suspiciously few props')
    const missing = names.filter((name) => !new RegExp(`\\bprev\\.${name}\\b`).test(body))
    assert.deepEqual(missing, [], `props missing from the comparator: ${missing.join(', ')}`)
  })

  it('compares the style object by value, not by identity', () => {
    // `style` is rebuilt on every render of the canvas, so an identity check
    // would defeat the memo entirely and re-render every widget every time.
    assert.match(comparatorBody(), /shallowStyleEqual\(prev\.style,\s*next\.style\)/)
  })
})
