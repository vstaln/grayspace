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

    assert.equal(parseWidgetInvocation('/web https://example.com')?.kind, 'browser')
    assert.equal(parseWidgetInvocation('/browser')?.kind, 'browser')

    assert.equal(parseWidgetInvocation('/plan')?.kind, 'planner')
    assert.equal(parseWidgetInvocation('/todo')?.kind, 'planner')
    assert.equal(parseWidgetInvocation('/tasks')?.kind, 'planner')

    assert.equal(parseWidgetInvocation('/orc')?.kind, 'orchestration')
    assert.equal(parseWidgetInvocation('/orch')?.kind, 'orchestration')
    assert.equal(parseWidgetInvocation('/agents')?.kind, 'orchestration')

    assert.equal(parseWidgetInvocation('/file')?.kind, 'files')
  })

  test('removed widget kinds no longer resolve', () => {
    for (const alias of ['/ai', '/ask', '/chat', '/sys', '/monitor', '/clock', '/time', '/music', '/link', '/note', '/calendar', '/kanban']) {
      assert.equal(parseWidgetInvocation(alias), null, `${alias} must not resolve after the cut`)
    }
  })

  test('supports prefix filter', () => {
    assert.ok(parseWidgetInvocation('/orch', '/'))
    assert.equal(parseWidgetInvocation('.orch', '/'), null)
    assert.ok(parseWidgetInvocation('.orch', '.'))
    assert.ok(parseWidgetInvocation('@orch', '@'))
  })

  test('returns null on unknown command name', () => {
    assert.equal(parseWidgetInvocation('/unknown-widget-kind'), null)
  })
})
