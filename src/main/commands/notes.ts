import type { BrainNote } from '../brain.ts'
import {
  CommandError,
  parseResource,
  type CommandPayloadSchema
} from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function noteIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'note') throw new CommandError('invalid', `${target} is not a note`)
  return parsed.id
}

/**
 * Deliberately open-ended: a note patch is whatever BrainStore accepts this
 * release, and enumerating every field here would let the schema drift into
 * lying. The common fields are documented so MCP tool descriptors stay useful;
 * nothing is rejected for being extra.
 */
const NOTE_PATCH_SCHEMA: CommandPayloadSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Note title' },
    content: { type: 'string', description: 'Markdown body; $ExactTitle links connect notes' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Shared tags wire notes into the graph' }
  }
}

export function registerNoteCommands({ core, brain }: CommandDeps): void {
  const { bus } = core

  bus.registerVersions('note', brain.versions)

  bus.registerDefinition<Partial<BrainNote>, BrainNote>({
    type: 'note.create',
    description: 'Create a Second Brain note.',
    targetScheme: 'note',
    ignoreVersion: true,
    payloadSchema: NOTE_PATCH_SCHEMA,
    handler: {
      apply: ({ command }) => brain.create(command.payload ?? {})
    }
  })

  bus.registerDefinition<Partial<BrainNote>, BrainNote>({
    type: 'note.update',
    description: 'Patch a note (title, content, tags). Send baseVersion to avoid clobbering a concurrent editor.',
    targetScheme: 'note',
    payloadSchema: NOTE_PATCH_SCHEMA,
    handler: {
      apply: ({ command }) => brain.update(noteIdOf(command.target), command.payload ?? {})
    }
  })

  /** Soft delete — the note moves to the trash and can be restored. */
  bus.registerDefinition<Record<string, never>, { id: string }>({
    type: 'note.delete',
    description: 'Move a note to the trash (restorable).',
    targetScheme: 'note',
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => {
        const id = noteIdOf(command.target)
        brain.remove(id)
        return { id }
      }
    }
  })

  bus.registerDefinition<Record<string, never>, BrainNote>({
    type: 'note.restore',
    description: 'Restore a note from the trash.',
    targetScheme: 'note',
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => brain.restore(noteIdOf(command.target))
    }
  })

  /** Permanent deletion. Destructive, so it is never replayed implicitly. */
  bus.registerDefinition<Record<string, never>, { id: string }>({
    type: 'note.purge',
    description: 'Permanently delete a trashed note. Destructive.',
    targetScheme: 'note',
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => {
        const id = noteIdOf(command.target)
        brain.purge(id)
        return { id }
      }
    }
  })
}
