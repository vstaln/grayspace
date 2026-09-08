import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ActorRegistry } from './actors.ts'
import { CommandFlow } from './flow.ts'
import { Journal } from './journal.ts'
import { LockManager } from './locks.ts'
import { validatePayload, type CommandDefinition } from './schema.ts'

describe('Command Schema Registry & Validation', () => {
  const noteCreateDef: CommandDefinition<{ title: string; content?: string; tags?: string[] }> = {
    type: 'note.create',
    description: 'Creates a new note record',
    targetScheme: 'note',
    payloadSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the note' },
        content: { type: 'string', description: 'Markdown body content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' }
      },
      required: ['title']
    }
  }

  test('validatePayload checks required fields and types', () => {
    assert.equal(validatePayload(noteCreateDef.payloadSchema, { title: 'My Note' }), null)
    assert.equal(
      validatePayload(noteCreateDef.payloadSchema, { content: 'Body without title' }),
      'missing required field "title"'
    )
    assert.equal(
      validatePayload(noteCreateDef.payloadSchema, { title: 123 as unknown as string }),
      'field "title" must be a string'
    )
    assert.equal(
      validatePayload(noteCreateDef.payloadSchema, { title: 'Note', tags: 'not-an-array' }),
      'field "tags" must be an array'
    )
  })

  test('bus validates payloads against registered schema definitions', async () => {
    const actors = new ActorRegistry()
    const locks = new LockManager()
    const journal = new Journal()
    const bus = new CommandFlow({ actors, locks, journal })

    actors.register({ id: 'user', type: 'user', label: 'User', transport: 'ipc' })

    bus.registerDefinition({
      ...noteCreateDef,
      handler: {
        ignoreVersion: true,
        apply: ({ command }) => ({ id: 'n1', title: (command.payload as { title: string }).title })
      }
    })

    // Valid command succeeds
    const validRes = await bus.submit({
      actorId: 'user',
      type: 'note.create',
      target: 'note:new',
      payload: { title: 'Valid Note' }
    })
    assert.equal(validRes.ok, true)

    // Invalid command fails schema validation before handler runs
    const invalidRes = await bus.submit({
      actorId: 'user',
      type: 'note.create',
      target: 'note:new',
      payload: { tags: ['no-title'] } as unknown as { title: string }
    })
    assert.equal(invalidRes.ok, false)
    assert.equal(invalidRes.code, 'invalid')
    assert.ok(invalidRes.message.includes('missing required field "title"'))

    // Catalog reflects registered definitions
    const catalog = bus.catalog()
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0].type, 'note.create')
  })
})
