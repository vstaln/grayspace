import type { BrainNote } from '../brain'
import { CommandError, parseResource } from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function noteIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'note') throw new CommandError('invalid', `${target} is not a note`)
  return parsed.id
}

export function registerNoteCommands({ core, brain }: CommandDeps): void {
  const { bus } = core

  bus.registerVersions('note', brain.versions)

  bus.register<Partial<BrainNote>, BrainNote>('note.create', {
    ignoreVersion: true,
    apply: ({ command }) => brain.create(command.payload ?? {})
  })

  bus.register<Partial<BrainNote>, BrainNote>('note.update', {
    apply: ({ command }) => brain.update(noteIdOf(command.target), command.payload ?? {})
  })

  /** Soft delete — the note moves to the trash and can be restored. */
  bus.register<Record<string, never>, { id: string }>('note.delete', {
    apply: ({ command }) => {
      const id = noteIdOf(command.target)
      brain.remove(id)
      return { id }
    }
  })

  bus.register<Record<string, never>, BrainNote>('note.restore', {
    ignoreVersion: true,
    apply: ({ command }) => brain.restore(noteIdOf(command.target))
  })

  /** Permanent deletion. Destructive, so it is never replayed implicitly. */
  bus.register<Record<string, never>, { id: string }>('note.purge', {
    apply: ({ command }) => {
      const id = noteIdOf(command.target)
      brain.purge(id)
      return { id }
    }
  })
}
