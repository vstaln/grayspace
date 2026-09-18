import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const indexSource = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
const configSource = readFileSync(fileURLToPath(new URL('./config.ts', import.meta.url)), 'utf8')

/**
 * `.env` has to be in the environment before any module reads it, and the only
 * thing that makes that true is being the first import — module bodies run in
 * import order, and every import runs before the importing file's own first
 * statement. This broke once already, silently: the `dotenv` call sat at the
 * top of index.ts looking first while config.ts had already captured
 * `WORKSPACE_CONTROL_PORT` into a module-level constant, so setting the
 * control port in `.env` did nothing at all.
 *
 * It is the kind of line an editor's import sorter moves without anyone
 * noticing, and nothing about the result looks wrong, so it is asserted here.
 */
describe('environment loading order', () => {
  it('loads .env from the first import in the main entry', () => {
    const firstImport = indexSource.match(/^import\s+.*$/m)?.[0]
    assert.equal(firstImport, "import './loadEnv.ts'")
  })

  it('still has something that reads the environment at module scope', () => {
    // If this ever stops being true the ordering above stops mattering — but
    // until then it is exactly why it does.
    assert.match(configSource, /^const .*process\.env|^export const .*process\.env/m)
  })
})
