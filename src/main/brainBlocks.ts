import { createHash } from 'crypto'
import { CommandError } from './core/types.ts'

export interface NoteBlock {
  id: string
  content: string
  version: number
}

function hashBlockId(content: string, index: number): string {
  const h = createHash('sha256').update(`${index}:${content.trim().slice(0, 100)}`).digest('hex').slice(0, 8)
  return `blk-${h}`
}

/**
 * Parses markdown text into ordered paragraph/section blocks.
 */
export function parseMarkdownToBlocks(markdown: string): NoteBlock[] {
  if (!markdown || !markdown.trim()) return []
  const rawParagraphs = markdown.split(/\n{2,}/)
  return rawParagraphs.map((p, idx) => ({
    id: hashBlockId(p, idx),
    content: p.trim(),
    version: 1
  }))
}

/**
 * Renders ordered blocks back into standard markdown.
 */
export function blocksToMarkdown(blocks: readonly NoteBlock[]): string {
  return blocks.map((b) => b.content).join('\n\n')
}

/**
 * Updates a specific block with optimistic concurrency version check.
 */
export function updateBlock(
  blocks: readonly NoteBlock[],
  blockId: string,
  newContent: string,
  baseVersion?: number
): NoteBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId)
  if (idx === -1) throw new CommandError('not_found', `block ${blockId} not found`)

  const current = blocks[idx]
  if (typeof baseVersion === 'number' && baseVersion !== current.version) {
    throw new CommandError(
      'conflict',
      `block ${blockId} modified concurrently: expected v${baseVersion}, found v${current.version}`
    )
  }

  const updated: NoteBlock = {
    ...current,
    content: newContent.trim(),
    version: current.version + 1
  }

  const next = blocks.slice()
  next[idx] = updated
  return next
}

/**
 * Inserts a new block after a specific block (or at the beginning if afterId is null).
 */
export function insertBlock(
  blocks: readonly NoteBlock[],
  afterId: string | null,
  content: string,
  id?: string
): NoteBlock[] {
  const newBlock: NoteBlock = {
    id: id || `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content: content.trim(),
    version: 1
  }

  if (!afterId) {
    return [newBlock, ...blocks]
  }

  const idx = blocks.findIndex((b) => b.id === afterId)
  if (idx === -1) {
    return [...blocks, newBlock]
  }

  const next = blocks.slice()
  next.splice(idx + 1, 0, newBlock)
  return next
}

/**
 * Deletes a block by id.
 */
export function deleteBlock(blocks: readonly NoteBlock[], blockId: string): NoteBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId)
  if (idx === -1) throw new CommandError('not_found', `block ${blockId} not found`)
  const next = blocks.slice()
  next.splice(idx, 1)
  return next
}

/**
 * Three-way block merge: merges independent block edits from user and agent without data loss.
 */
export function mergeBlockEdits(
  base: readonly NoteBlock[],
  branchA: readonly NoteBlock[],
  branchB: readonly NoteBlock[]
): NoteBlock[] {
  const baseMap = new Map(base.map((b) => [b.id, b]))
  const aMap = new Map(branchA.map((b) => [b.id, b]))
  const bMap = new Map(branchB.map((b) => [b.id, b]))

  const allIds = new Set<string>([
    ...branchA.map((b) => b.id),
    ...branchB.map((b) => b.id)
  ])

  const result: NoteBlock[] = []

  for (const id of allIds) {
    const orig = baseMap.get(id)
    const inA = aMap.get(id)
    const inB = bMap.get(id)

    if (inA && inB) {
      if (inA.content === inB.content) {
        result.push(inA)
      } else if (orig && inA.content === orig.content) {
        result.push(inB) // B modified
      } else if (orig && inB.content === orig.content) {
        result.push(inA) // A modified
      } else {
        // Both modified: append B's modification cleanly
        result.push(inA)
        result.push({ ...inB, id: `${inB.id}-conflict` })
      }
    } else if (inA && !inB) {
      if (!orig) result.push(inA) // A added
      // else B deleted, do not include
    } else if (inB && !inA) {
      if (!orig) result.push(inB) // B added
      // else A deleted, do not include
    }
  }

  return result
}
