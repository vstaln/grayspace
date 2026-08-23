import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleBotCommand } from './botCommands.ts'

function fakeDeps(overrides: {
  widgets?: Array<{ id: string; title: string; kind?: string }>
  targetTerminalId?: string
  submit?: (cmd: { type: string; payload?: unknown; target?: string }) => Promise<unknown>
} = {}): {
  deps: Parameters<typeof handleBotCommand>[1]
  patches: unknown[]
} {
  const patches: unknown[] = []
  const state = {
    settings: { targetTerminalId: overrides.targetTerminalId },
    patchSettings: (patch: unknown): unknown => {
      patches.push(patch)
      Object.assign(state.settings, patch)
      return state.settings
    }
  }
  const canvas = {
    listWidgets: (): unknown[] => (overrides.widgets ?? []).map((w) => ({ kind: 'terminal', ...w }))
  }
  const core = {
    bus: {
      submit: overrides.submit ?? (async () => ({ ok: true, seq: 0, version: 0, data: {} }))
    }
  }
  return { deps: { core, canvas, state, actorId: 'telegram' } as never, patches }
}

test('non-command text returns null so callers forward it as terminal input', async () => {
  const { deps } = fakeDeps()
  assert.equal(await handleBotCommand('hello world', deps), null)
})

test('/help lists commands', async () => {
  const { deps } = fakeDeps()
  const reply = await handleBotCommand('/help', deps)
  assert.match(reply ?? '', /\/status/)
  assert.match(reply ?? '', /\/terminals/)
})

test('/status reports no target terminal when unset', async () => {
  const { deps } = fakeDeps()
  const reply = await handleBotCommand('/status', deps)
  assert.match(reply ?? '', /не выбран/)
})

test('/terminals lists widgets with a marker on the current target', async () => {
  const { deps } = fakeDeps({
    widgets: [{ id: 'term-1', title: 'Terminal 1' }, { id: 'term-2', title: 'Terminal 2' }],
    targetTerminalId: 'term-2'
  })
  const reply = await handleBotCommand('/terminals', deps)
  assert.equal(reply, '1. Terminal 1\n2. Terminal 2  ← текущий')
})

test('/use switches the target terminal by list index', async () => {
  const { deps, patches } = fakeDeps({
    widgets: [{ id: 'term-1', title: 'Terminal 1' }, { id: 'term-2', title: 'Terminal 2' }]
  })
  const reply = await handleBotCommand('/use 2', deps)
  assert.equal(reply, 'Целевой терминал: Terminal 2')
  assert.deepEqual(patches, [{ targetTerminalId: 'term-2' }])
})

test('/use rejects an out-of-range index', async () => {
  const { deps, patches } = fakeDeps({ widgets: [{ id: 'term-1', title: 'Terminal 1' }] })
  const reply = await handleBotCommand('/use 5', deps)
  assert.match(reply ?? '', /от 1 до 1/)
  assert.deepEqual(patches, [])
})

test('/new creates a terminal and switches the target to it', async () => {
  const { deps, patches } = fakeDeps({
    submit: async (cmd) => {
      assert.equal(cmd.type, 'terminal.create')
      return { ok: true, seq: 0, version: 0, data: { id: 'term-9', title: 'Claude' } }
    }
  })
  const reply = await handleBotCommand('/new Claude', deps)
  assert.equal(reply, 'Создан терминал «Claude» — он теперь целевой.')
  assert.deepEqual(patches, [{ targetTerminalId: 'term-9' }])
})

test('/new surfaces a failure without touching settings', async () => {
  const { deps, patches } = fakeDeps({
    submit: async () => ({ ok: false, code: 'failed', message: 'window not open' })
  })
  const reply = await handleBotCommand('/new', deps)
  assert.match(reply ?? '', /window not open/)
  assert.deepEqual(patches, [])
})

test('/stop sends Ctrl+C to the target terminal', async () => {
  let sent: unknown
  const { deps } = fakeDeps({
    targetTerminalId: 'term-1',
    submit: async (cmd) => {
      sent = cmd
      return { ok: true, seq: 0, version: 0, data: {} }
    }
  })
  const reply = await handleBotCommand('/stop', deps)
  assert.equal(reply, 'Отправлено Ctrl+C в целевой терминал.')
  assert.deepEqual(sent, {
    actorId: 'telegram',
    type: 'terminal.input',
    target: 'terminal:term-1',
    payload: { data: '\x03' }
  })
})

test('/stop without a target terminal does not submit anything', async () => {
  let called = false
  const { deps } = fakeDeps({ submit: async () => { called = true; return { ok: true, seq: 0, version: 0, data: {} } } })
  const reply = await handleBotCommand('/stop', deps)
  assert.match(reply ?? '', /не выбран/)
  assert.equal(called, false)
})

test('unknown command points to /help', async () => {
  const { deps } = fakeDeps()
  const reply = await handleBotCommand('/frobnicate', deps)
  assert.match(reply ?? '', /Неизвестная команда/)
})

test('telegram group @botname suffix is stripped', async () => {
  const { deps } = fakeDeps()
  const reply = await handleBotCommand('/help@MyOrcSpaceBot', deps)
  assert.match(reply ?? '', /\/status/)
})
