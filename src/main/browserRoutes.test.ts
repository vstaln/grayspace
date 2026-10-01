import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-browser-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

const { createCore } = await import('./core/index.ts')
const { OrchestrationStore } = await import('./orchestration/store.ts')
const { registerCommands } = await import('./commands/index.ts')
const { TerminalManager } = await import('./terminals.ts')
const { TerminalSnapshots } = await import('./terminalSnapshots.ts')
const { PlannerStore } = await import('./plannerStore.ts')
const { NotesStore } = await import('./notesStore.ts')
const { CanvasStore } = await import('./canvasState.ts')
const { startControlServer } = await import('./controlServer.ts')
const { controlToken } = await import('./controlToken.ts')
const { CONTROL_TOKEN_HEADER } = await import('./controlToken.ts')
const { resolveBrowserAgentAction } = await import('./browserAutomation.ts')

describe('orc browser in the Code view', () => {
  const port = 20247
  const codeSessions: Array<{ id: string; agentId: string; label: string; command: string; title?: string; status?: 'active' | 'finished' }> = []
  const broadcasts: Array<{ channel: string; payload: Record<string, unknown> }> = []
  let server: ReturnType<typeof startControlServer>
  let canvas: InstanceType<typeof CanvasStore>

  // Plays the renderer: Code opens a session and every browser answers.
  const broadcast = (channel: string, payload: unknown): void => {
    const body = payload as Record<string, unknown>
    broadcasts.push({ channel, payload: body })
    setImmediate(() => {
      if (channel === 'browser:open-in-code') {
        resolveBrowserAgentAction(String(body.requestId), { ok: true, result: { id: 'code-100-7' } })
      } else if (channel === 'browser:agent-action') {
        resolveBrowserAgentAction(String(body.requestId), { ok: true, result: { widgetId: body.widgetId } })
      }
    })
  }

  before(async () => {
    const core = createCore()
    const orchestration = new OrchestrationStore({ file: join(userData, 'orchestration.json') })
    const terminals = new TerminalManager()
    const planner = new PlannerStore()
    const notes = new NotesStore()
    canvas = new CanvasStore()
    registerCommands({
      core, canvas, planner, notes, orchestration, terminals,
      snapshots: new TerminalSnapshots(),
      requestWidget: () => {},
      requestWidgetRemoval: () => {},
      originWidgetId: () => null,
      forgetOrigin: () => {},
      defaultCwd: () => userData
    })
    server = startControlServer({
      allowTcp: true, core, terminals, planner, notes, orchestration, canvas, port,
      code: { snapshot: () => ({ schemaVersion: 1, sessions: codeSessions, featuredId: null, maximizedId: null, version: 1 }) },
      state: { workspaceDir: userData } as never,
      defaultCwd: () => userData,
      broadcast
    })
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  })

  after(() => {
    server.close()
    fs.rmSync(userData, { recursive: true, force: true })
  })

  async function call(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; json: Record<string, any> }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: controlToken() },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, json: await res.json() as Record<string, any> }
  }

  test('an agent in Code opens its browser in Code, not on the canvas', async () => {
    const before = canvas.listWidgets().length
    const res = await call('POST', '/browser/open', { agentId: 'code-100-1', url: 'http://localhost:3000' })
    assert.equal(res.status, 201)
    assert.equal(res.json.data.id, 'code-100-7')
    assert.equal(res.json.data.surface, 'code')
    assert.equal(canvas.listWidgets().length, before)
    const navigate = broadcasts.find((b) => b.channel === 'browser:agent-action' && b.payload.widgetId === 'code-100-7')
    assert.ok(navigate, 'the new Code browser is navigated')
  })

  test('Code browsers are listed and accept actions', async () => {
    codeSessions.push({ id: 'code-100-9', agentId: 'browser', label: 'Browser', command: '', title: 'Docs', status: 'active' })
    const list = await call('GET', '/browser?agentId=code-100-1')
    const ids = (list.json.browsers as Array<{ id: string; surface: string }>).map((b) => `${b.id}:${b.surface}`)
    assert.ok(ids.includes('code-100-9:code'))
    const snap = await call('GET', '/browser/code-100-9/snapshot?agentId=code-100-1')
    assert.equal(snap.status, 200)
    assert.equal(snap.json.data.widgetId, 'code-100-9')
  })

  test('a finished or unknown Code session is not a browser', async () => {
    codeSessions.push({ id: 'code-100-10', agentId: 'claude', label: 'Claude', command: 'claude', status: 'active' })
    const res = await call('GET', '/browser/code-100-10/snapshot?agentId=code-100-1')
    assert.equal(res.status, 404)
  })

  test('a canvas agent can still request the in-app canvas browser explicitly', async () => {
    // The default surface for a canvas-context agent is now the user's real
    // Chrome (see routeBrowser in controlServer.ts) so an agent's browsing is
    // visible instead of headless-feeling; that path launches an actual
    // browser process and isn't something this suite should trigger, so this
    // test asserts the still-supported opt-in canvas widget instead.
    const res = await call('POST', '/browser/open', { agentId: 'term-1', surface: 'canvas' })
    assert.equal(res.status, 201)
    assert.equal(res.json.data.surface, 'canvas')
    assert.equal(canvas.widget(res.json.data.id)?.kind, 'browser')
  })
})
