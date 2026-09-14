import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseWidgetInvocation } from './commandInput.ts'

describe('parseWidgetInvocation', () => {
  test('returns null on empty or whitespace string', () => {
    assert.equal(parseWidgetInvocation(''), null)
    assert.equal(parseWidgetInvocation('   '), null)
  })

  test('parses commands with slash prefix', () => {
    const result = parseWidgetInvocation('/terminal npm test')
    assert.deepEqual(result, {
      kind: 'terminal',
      initialCommand: 'npm test'
    })
  })

  test('parses common aliases', () => {
    assert.equal(parseWidgetInvocation('/term')?.kind, 'terminal')
    assert.equal(parseWidgetInvocation('/sh')?.kind, 'terminal')
    assert.equal(parseWidgetInvocation('/shell')?.kind, 'terminal')
    assert.equal(parseWidgetInvocation('/cmd')?.kind, 'terminal')

    assert.equal(parseWidgetInvocation('/ai')?.kind, 'chat')
    assert.equal(parseWidgetInvocation('/ask')?.kind, 'chat')
    assert.equal(parseWidgetInvocation('/chat hello')?.initialCommand, 'hello')

    assert.equal(parseWidgetInvocation('/web https://example.com')?.kind, 'browser')
    assert.equal(parseWidgetInvocation('/browser')?.kind, 'browser')

    assert.equal(parseWidgetInvocation('/plan')?.kind, 'planner')
    assert.equal(parseWidgetInvocation('/todo')?.kind, 'planner')
    assert.equal(parseWidgetInvocation('/tasks')?.kind, 'planner')

    assert.equal(parseWidgetInvocation('/orc')?.kind, 'orchestration')
    assert.equal(parseWidgetInvocation('/orch')?.kind, 'orchestration')
    assert.equal(parseWidgetInvocation('/agents')?.kind, 'orchestration')

    assert.equal(parseWidgetInvocation('/sys')?.kind, 'sys-monitor')
    assert.equal(parseWidgetInvocation('/monitor')?.kind, 'sys-monitor')

    assert.equal(parseWidgetInvocation('/clock')?.kind, 'timer')
    assert.equal(parseWidgetInvocation('/time')?.kind, 'timer')
  })

  test('supports prefix filter', () => {
    assert.ok(parseWidgetInvocation('/ai', '/'))
    assert.equal(parseWidgetInvocation('.ai', '/'), null)
    assert.ok(parseWidgetInvocation('.ai', '.'))
    assert.ok(parseWidgetInvocation('@ai', '@'))
  })

  test('returns null on unknown command name', () => {
    assert.equal(parseWidgetInvocation('/unknown-widget-kind'), null)
  })
})
