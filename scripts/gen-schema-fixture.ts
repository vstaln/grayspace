#!/usr/bin/env node
// Golden fixture for payload validation. The returned message becomes an
// `invalid` command error that agents read, so both the wording and the order
// of the checks are contract, not cosmetics — a payload breaking two rules must
// report the same one in both implementations.
//
// Regenerate with:  node scripts/gen-schema-fixture.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePayload, type CommandPayloadSchema } from '../src/main/core/schema.ts'

const schema: CommandPayloadSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    count: { type: 'number' },
    flag: { type: 'boolean' },
    tags: { type: 'array' },
    meta: { type: 'object' },
    mode: { type: 'string', enum: ['fast', 'slow'] },
    anything: { type: 'any' }
  },
  required: ['title'],
  additionalProperties: false
}

const open: CommandPayloadSchema = {
  type: 'object',
  properties: { title: { type: 'string' } }
}

const cases: { name: string; schema: 'strict' | 'open'; payload: unknown }[] = [
  { name: 'valid minimal', schema: 'strict', payload: { title: 'ok' } },
  { name: 'valid full', schema: 'strict', payload: { title: 'ok', count: 1, flag: true, tags: [], meta: {}, mode: 'fast', anything: 'x' } },

  { name: 'not an object', schema: 'strict', payload: 'nope' },
  { name: 'null payload', schema: 'strict', payload: null },
  { name: 'array payload', schema: 'strict', payload: [] },

  { name: 'missing required', schema: 'strict', payload: { count: 1 } },
  { name: 'required present but null', schema: 'strict', payload: { title: null } },

  { name: 'unexpected field', schema: 'strict', payload: { title: 'ok', extra: 1 } },
  { name: 'unexpected allowed when open', schema: 'open', payload: { title: 'ok', extra: 1 } },

  { name: 'wrong string', schema: 'strict', payload: { title: 5 } },
  { name: 'wrong number', schema: 'strict', payload: { title: 'ok', count: 'five' } },
  { name: 'wrong boolean', schema: 'strict', payload: { title: 'ok', flag: 'yes' } },
  { name: 'wrong array', schema: 'strict', payload: { title: 'ok', tags: {} } },
  { name: 'wrong object', schema: 'strict', payload: { title: 'ok', meta: [] } },
  { name: 'any accepts anything', schema: 'strict', payload: { title: 'ok', anything: [1, 2] } },

  { name: 'bad enum', schema: 'strict', payload: { title: 'ok', mode: 'medium' } },
  // enum is checked before type, so a non-string here reports the enum message.
  { name: 'enum beats type', schema: 'strict', payload: { title: 'ok', mode: 7 } },

  // Ordering: required is checked before unexpected fields, and unexpected
  // before per-property types.
  { name: 'missing required beats unexpected', schema: 'strict', payload: { extra: 1 } },
  { name: 'unexpected beats wrong type', schema: 'strict', payload: { title: 5, extra: 1 } },

  { name: 'null field is skipped', schema: 'strict', payload: { title: 'ok', count: null } }
]

const results = cases.map((testCase) => ({
  name: testCase.name,
  schema: testCase.schema,
  payload: testCase.payload,
  error: validatePayload(testCase.schema === 'strict' ? schema : open, testCase.payload)
}))

const outFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'native', 'orcspace-app', 'tests', 'fixtures', 'schema-validation.json'
)
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify({ cases: results }, null, 2) + '\n', 'utf8')
console.log(`Wrote ${results.length} validation cases`)
for (const r of results) console.log(`  ${r.name.padEnd(36)} -> ${r.error ?? 'ok'}`)
