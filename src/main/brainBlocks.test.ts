import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  parseMarkdownToBlocks,
  blocksToMarkdown,
  updateBlock,
  insertBlock,
  deleteBlock,
  mergeBlockEdits
} from './brainBlocks.ts'

describe('Block-level Concurrent Note Editing (Paragraph CRDT/OT)', () => {
  test('parses markdown to blocks and renders back symmetrically', () => {
    const md = '# Title\n\nFirst paragraph.\n\nSecond paragraph.'
    const blocks = parseMarkdownToBlocks(md)

    assert.equal(blocks.length, 3)
    assert.equal(blocks[0].content, '# Title')
    assert.equal(blocks[1].content, 'First paragraph.')
    assert.equal(blocks[2].content, 'Second paragraph.')

    const rendered = blocksToMarkdown(blocks)
    assert.equal(rendered, md)
  })

  test('updates single block with optimistic concurrency version check', () => {
    const blocks = parseMarkdownToBlocks('Paragraph 1\n\nParagraph 2')
    const updated = updateBlock(blocks, blocks[0].id, 'Paragraph 1 edited', 1)

    assert.equal(updated[0].content, 'Paragraph 1 edited')
    assert.equal(updated[0].version, 2)
    assert.equal(updated[1].content, 'Paragraph 2')
    assert.equal(updated[1].version, 1)
  })

  test('merges independent concurrent edits from human and agent without data loss', () => {
    const base = parseMarkdownToBlocks('Intro\n\nSection A\n\nSection B')

    // Human edits Section A
    const humanEdits = updateBlock(base, base[1].id, 'Section A (Human improvements)')

    // Agent edits Section B
    const agentEdits = updateBlock(base, base[2].id, 'Section B (Agent documentation added)')

    // Merge concurrent edits
    const merged = mergeBlockEdits(base, humanEdits, agentEdits)

    assert.equal(merged.length, 3)
    assert.equal(merged[0].content, 'Intro')
    assert.equal(merged[1].content, 'Section A (Human improvements)')
    assert.equal(merged[2].content, 'Section B (Agent documentation added)')
  })
})
