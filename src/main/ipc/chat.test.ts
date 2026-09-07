import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { parseAgyModels, parseGrokModels, parseOpenCodeZenModels, registerChatIpc } from './chat.ts'
import type { IpcDeps } from './types.ts'

describe('registerChatIpc', () => {
  test('registers chat:send, chat:stop, chat:dispose handlers', () => {
    const handlers = new Map<string, Function>()
    const oldElectronMock = (globalThis as any).__electronMock
    ;(globalThis as any).__electronMock = {
      ipcMain: {
        handle: (channel: string, fn: Function) => {
          handlers.set(channel, fn)
        }
      }
    }

    const mockDeps = {
      getWindow: () => null,
      getWorkspaceDir: () => 'C:/dummy',
      core: {} as any,
      terminals: {} as any,
      coordination: {} as any,
      planner: {} as any,
      orchestration: {} as any,
      canvas: {} as any,
      code: {} as any,
      state: {} as any,
      setWorkspaceDir: () => {}
    } as unknown as IpcDeps

    registerChatIpc(mockDeps)

    assert.ok(handlers.has('chat:send'))
    assert.ok(handlers.has('chat:stop'))
    assert.ok(handlers.has('chat:dispose'))
    assert.ok(handlers.has('chat:models'))

    const sendHandler = handlers.get('chat:send')!
    // Validate invalid input
    assert.deepEqual(sendHandler({}, null, 'claude', 'hi'), { error: 'invalid thread id' })
    assert.deepEqual(sendHandler({}, 'th-1', 'bad-model', 'hi'), { error: 'unknown model' })
    assert.deepEqual(sendHandler({}, 'th-1', 'claude', null), { error: 'invalid prompt' })

    const stopHandler = handlers.get('chat:stop')!
    assert.deepEqual(stopHandler({}, null), { ok: false })
    assert.deepEqual(stopHandler({}, 'th-non-existent'), { ok: false })

    const disposeHandler = handlers.get('chat:dispose')!
    assert.deepEqual(disposeHandler({}, null), { ok: false })
    assert.deepEqual(disposeHandler({}, 'th-non-existent'), { ok: true })

    ;(globalThis as any).__electronMock = oldElectronMock
  })
})

describe('chat model discovery parsers', () => {
  test('uses current Antigravity CLI ids and labels', () => {
    const models = parseAgyModels('Fetching available models...\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)')
    assert.deepEqual(models.map((model) => model.id), ['gemini-3.7-flash-high', 'claude-sonnet-4-6'])
  })

  test('keeps only models that Grok marks available', () => {
    const models = parseGrokModels('Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)')
    assert.deepEqual(models.map((model) => model.id), ['grok-4.6'])
  })

  test('keeps only the OpenCode Zen provider', () => {
    const models = parseOpenCodeZenModels('opencode/big-pickle\nanthropic/claude-sonnet\nopencode/mimo-v2.5-free')
    assert.deepEqual(models.map((model) => model.id), ['opencode/big-pickle', 'opencode/mimo-v2.5-free'])
  })
})
