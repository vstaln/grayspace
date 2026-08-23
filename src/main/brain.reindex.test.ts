import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { reindexJs, reindexNative, type ReindexInput } from './brain.ts'

const notes: ReindexInput[] = [
  {
    id: 'a',
    title: 'Alpha',
    content: '[[Beta]] [[Beta|alias]] [[Missing]] $Gamma $Alpha [[]] [[a][b]] [[foo',
    alive: true
  },
  { id: 'b', title: 'Beta', content: '[[Alpha]]', alive: true },
  { id: 'g', title: 'Gamma', content: '', alive: true },
  { id: 'u', title: 'Жук', content: '$Жук', alive: true },
  { id: 'dead', title: 'Gone', content: '', alive: false },
  {
    id: 's',
    title: 'Source',
    content: '$gAmMa ($жук) foo$Жук [[Жук]] [[Gone]] [[Beta]]',
    alive: true
  },
  {
    // Regression case: a run of 3+ opening brackets before a valid target. The
    // JS regex resolves `[[foo]]` via the 2nd/3rd bracket even though the 1st/2nd
    // bracket attempt fails first — a hand-rolled scanner must retry position-by-
    // position rather than skip past the failed attempt, or it silently drops the link.
    id: 'n',
    title: 'Nested',
    content: 'x[[[foo]]y',
    alive: true
  }
]

const expected = {
  wiki: [
    { id: 'a', links: ['b'], unresolved: ['Missing'] },
    { id: 'b', links: ['a'], unresolved: [] },
    { id: 'g', links: [], unresolved: [] },
    { id: 'u', links: [], unresolved: [] },
    { id: 'dead', links: [], unresolved: [] },
    { id: 's', links: ['u', 'b'], unresolved: ['Gone'] },
    { id: 'n', links: [], unresolved: ['foo'] }
  ],
  dollar: [
    { id: 'a', links: ['g'], unresolved: [] },
    { id: 'b', links: [], unresolved: [] },
    { id: 'g', links: [], unresolved: [] },
    { id: 'u', links: [], unresolved: [] },
    { id: 'dead', links: [], unresolved: [] },
    { id: 's', links: ['g', 'u'], unresolved: [] },
    { id: 'n', links: [], unresolved: [] }
  ],
  both: [
    { id: 'a', links: ['b', 'g'], unresolved: ['Missing'] },
    { id: 'b', links: ['a'], unresolved: [] },
    { id: 'g', links: [], unresolved: [] },
    { id: 'u', links: [], unresolved: [] },
    { id: 'dead', links: [], unresolved: [] },
    { id: 's', links: ['u', 'b', 'g'], unresolved: ['Gone'] },
    { id: 'n', links: [], unresolved: ['foo'] }
  ]
} satisfies Record<string, ReturnType<typeof reindexJs>>

describe('brain reindex equivalence', () => {
  for (const syntax of ['wiki', 'dollar', 'both'] as const) {
    test(`${syntax} syntax`, () => {
      const js = reindexJs(notes, syntax)
      assert.deepEqual(js, expected[syntax])

      const native = reindexNative(notes, syntax)
      if (native !== null) assert.deepEqual(native, js)
    })
  }
})
