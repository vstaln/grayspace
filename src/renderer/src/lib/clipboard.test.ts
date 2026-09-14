import { strict as assert } from 'node:assert'
import { afterEach, describe, test } from 'node:test'
import { copyText } from './clipboard.ts'

const globals = globalThis as typeof globalThis & { window?: unknown }
const originalWindow = globals.window

afterEach(() => {
  globals.window = originalWindow
})

describe('copyText', () => {
  test('prefers the main-process clipboard bridge', async () => {
    const copied: string[] = []
    globals.window = {
      api: {
        media: {
          writeClipboardText: async (text: string) => {
            copied.push(text)
            return { ok: true }
          }
        }
      },
      navigator: { clipboard: { writeText: async () => assert.fail('fallback must not run') } }
    }

    assert.equal(await copyText('Victor'), true)
    assert.deepEqual(copied, ['Victor'])
  })

  test('reports bridge errors without claiming success', async () => {
    globals.window = {
      api: { media: { writeClipboardText: async () => ({ error: 'denied' }) } }
    }

    assert.equal(await copyText('Victor'), false)
  })

  test('falls back to the browser clipboard for older preloads', async () => {
    const copied: string[] = []
    globals.window = {
      api: { media: {} },
      navigator: { clipboard: { writeText: async (text: string) => void copied.push(text) } }
    }

    assert.equal(await copyText('Victor'), true)
    assert.deepEqual(copied, ['Victor'])
  })
})
