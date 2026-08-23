import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TelegramBot, isTelegramUserAllowed, isTelegramChatAllowed } from './telegramBot.ts'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fakeBot(options: ConstructorParameters<typeof TelegramBot>[3] = {}, settingsOverride: Record<string, unknown> = {}): {
  bot: TelegramBot
  writes: string[]
} {
  const writes: string[] = []
  const state = {
    settings: {
      telegramBotToken: 'top-secret-token',
      telegramUserId: '123456',
      targetTerminalId: 'term-1',
      ...settingsOverride
    },
    patchSettings: (): unknown => undefined
  }
  const core = {
    actors: { register: (): unknown => undefined },
    bus: {
      submit: async ({ type, payload }: { type?: string; payload?: { data?: string } }): Promise<{ ok: true; seq: number; version: number; data: Record<string, never> }> => {
        if (type === 'terminal.input') writes.push(payload?.data ?? '')
        return { ok: true, seq: 0, version: 0, data: {} }
      }
    }
  }
  const canvas = { listWidgets: (): unknown[] => [] }
  return {
    bot: new TelegramBot(state as never, core as never, canvas as never, options),
    writes
  }
}

test('Telegram allowlist compares normalized ids safely across number/string API boundaries and multiple IDs', () => {
  assert.equal(isTelegramUserAllowed(123456, '123456'), true)
  assert.equal(isTelegramUserAllowed('123456', '123456'), true)
  assert.equal(isTelegramUserAllowed(123456, '654321'), false)
  assert.equal(isTelegramUserAllowed('123456', ' 123456 '), true)
  assert.equal(isTelegramUserAllowed(123456, '654321, 123456, 999999'), true)
  assert.equal(isTelegramUserAllowed(777777, '654321, 123456, 999999'), false)
  assert.equal(isTelegramChatAllowed(123456, '123456'), true)
})

test('incoming messages write when sender user ID (from.id) matches allowed user ID, even from a group chat', () => {
  const { bot, writes } = fakeBot()
  const handleMessage = (bot as unknown as { handleMessage(update: unknown): void }).handleMessage.bind(bot)
  // Direct message
  handleMessage({ update_id: 1, message: { text: 'allowed-dm', from: { id: 123456 }, chat: { id: 123456 } } })
  // Group message from authorized user (chat.id is negative group ID, from.id is user ID)
  handleMessage({ update_id: 2, message: { text: 'allowed-group', from: { id: 123456 }, chat: { id: -1001234567890 } } })
  // Group message from unauthorized user
  handleMessage({ update_id: 3, message: { text: 'blocked-group', from: { id: 654321 }, chat: { id: -1001234567890 } } })
  // Message without from object falling back to chat id
  handleMessage({ update_id: 4, message: { text: 'fallback-chat', chat: { id: 123456 } } })
  assert.deepEqual(writes, ['allowed-dm\r\n', 'allowed-group\r\n', 'fallback-chat\r\n'])
})

test('polling backs off after a transient failure and resumes instead of dying', async () => {
  const delays: number[] = []
  const { bot } = fakeBot({ sleep: async (ms) => { delays.push(ms) } })
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls += 1
    if (calls === 1 || calls === 3) return response({ ok: true, result: {} })
    if (calls === 2) throw new Error('temporary network failure')
    bot.stop()
    return response({ ok: true, result: [] })
  }
  try {
    bot.refresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(calls, 4)
    assert.deepEqual(delays, [1000])
    assert.equal(bot.getStatus().state, 'disconnected')
  } finally {
    bot.stop()
    globalThis.fetch = originalFetch
  }
})

test('refresh aborts the previous poller so connecting twice cannot duplicate polling', async () => {
  const { bot } = fakeBot({ sleep: async () => {} })
  const originalFetch = globalThis.fetch
  const signals: (AbortSignal | undefined)[] = []
  let getUpdatesCalls = 0
  globalThis.fetch = async (_input, init) => {
    signals.push(init?.signal ?? undefined)
    if (signals.length % 2 === 1) return response({ ok: true, result: {} })
    getUpdatesCalls += 1
    return await new Promise<Response>(resolve => {
      init?.signal?.addEventListener('abort', () => resolve(response({ ok: true, result: [] })), { once: true })
    })
  }
  try {
    bot.refresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    bot.refresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(signals[1]?.aborted, true)
    assert.equal(getUpdatesCalls, 2)
  } finally {
    bot.stop()
    globalThis.fetch = originalFetch
  }
})

test('testSend returns a sanitized error and does not throw when Telegram fails', async () => {
  const { bot } = fakeBot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('fetch failed for https://api.telegram.org/bottop-secret-token/sendMessage')
  }
  try {
    const result = await bot.testSend()
    if (!('error' in result)) assert.fail('testSend unexpectedly succeeded')
    assert.equal(result.error.includes('top-secret-token'), false)
    assert.equal(bot.getStatus().state, 'error')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendMessage targets telegramUserId or falls back to telegramChatId', async () => {
  const lastCall = { body: null as { chat_id?: string } | null }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    lastCall.body = JSON.parse(String(init?.body)) as { chat_id?: string }
    return response({ ok: true, result: {} })
  }
  try {
    // With telegramUserId
    const { bot: botWithUserId } = fakeBot({}, { telegramUserId: '555555', telegramChatId: undefined })
    const res1 = await botWithUserId.sendMessage('Hello user!')
    assert.deepEqual(res1, { ok: true })
    assert.equal(lastCall.body?.chat_id, '555555')

    // With legacy telegramChatId
    const { bot: botWithChatId } = fakeBot({}, { telegramUserId: undefined, telegramChatId: '666666' })
    const res2 = await botWithChatId.sendMessage('Hello chat!')
    assert.deepEqual(res2, { ok: true })
    assert.equal(lastCall.body?.chat_id, '666666')

    // Without user or chat ID
    const { bot: botWithoutTarget } = fakeBot({}, { telegramUserId: undefined, telegramChatId: undefined })
    const res3 = await botWithoutTarget.sendMessage('Hello?')
    assert.deepEqual(res3, { error: 'Telegram user ID is not configured' })
  } finally {
    globalThis.fetch = originalFetch
  }
})
