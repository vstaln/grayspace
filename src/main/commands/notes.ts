import type { NoteItem } from '../notesStore.ts'
import { CommandError, parseResource, type CommandPayloadSchema } from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function noteIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'note') throw new CommandError('invalid', `${target} is not a note`)
  return parsed.id
}

interface NoteCreatePayload {
  title?: string
  body?: string
  tags?: string[]
  category?: string
  color?: string
}

interface NoteUpdatePayload {
  title?: string
  body?: string
  tags?: string[]
  category?: string | null
  color?: string | null
  order?: number
}

const NOTE_FIELDS: CommandPayloadSchema['properties'] = {
  title: { type: 'string', description: 'Note title' },
  body: { type: 'string', description: 'Note body text' },
  tags: { type: 'array', description: 'Free-form tags' },
  category: { type: 'string', description: 'Groups notes and gives them a shared color; assigned automatically if omitted' },
  color: { type: 'string', description: '#rrggbb; overrides the category color for this note (or the whole category via note.recolor)' }
}

export function registerNotesCommands({ core, notes }: CommandDeps): void {
  const { flow } = core

  flow.registerVersions('note', notes.versions)

  flow.registerDefinition<NoteCreatePayload, NoteItem>({
    type: 'note.create',
    description: 'Create a note with optional tags and a category. The category gets an automatic color the first time it is used.',
    targetScheme: 'note',
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: NOTE_FIELDS },
    handler: {
      apply: ({ command, actor }) => {
        const p = command.payload ?? {}
        return notes.createItem({ ...p, createdBy: actor.id })
      }
    }
  })

  flow.registerDefinition<NoteUpdatePayload, NoteItem>({
    type: 'note.update',
    description: 'Update a note (title, body, tags, category, color, order). Pass null for category/color to clear them.',
    targetScheme: 'note',
    payloadSchema: {
      type: 'object',
      properties: { ...NOTE_FIELDS, order: { type: 'number' } }
    },
    handler: {
      apply: ({ command }) => notes.updateItem(noteIdOf(command.target), command.payload ?? {})
    }
  })

  flow.registerDefinition<{ category?: string; color?: string }, { ok: true }>({
    type: 'note.recolor',
    description: 'Set a category\'s color; every note already in that category updates to match.',
    targetScheme: 'note',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category name' },
        color: { type: 'string', description: '#rrggbb' }
      }
    },
    handler: {
      apply: ({ command }) => {
        const p = command.payload ?? {}
        notes.setCategoryColor(p.category ?? '', p.color ?? '')
        return { ok: true }
      }
    }
  })

  flow.registerDefinition<Record<string, never>, { id: string }>({
    type: 'note.delete',
    description: 'Delete a note.',
    targetScheme: 'note',
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => {
        const id = noteIdOf(command.target)
        notes.deleteItem(id)
        return { id }
      }
    }
  })
}
