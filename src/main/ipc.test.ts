import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, test } from 'node:test'

const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-ipc-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

// Create mock ipcMain
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const listeners = new Map<string, (...args: unknown[]) => void>()

const electronMock = {
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, listener)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    },
    removeAllListeners: (channel: string) => {
      listeners.delete(channel)
    }
  },
  app: {
    getPath: () => userData,
    isPackaged: false
  },
  dialog: {},
  shell: {},
  BrowserWindow: {}
}

// Intercept electron import for this module test
const originalCustomRequire = (globalThis as unknown as { __electronMock?: typeof electronMock })
originalCustomRequire.__electronMock = electronMock

import type { TerminalManager } from './terminals.ts'
import type { TerminalSnapshots } from './terminalSnapshots.ts'
import type { CoordinationStore } from './coordination.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { BrainStore } from './brain.ts'
import type { CanvasStore } from './canvasState.ts'
import type { AppState } from './appState.ts'

const { createCore } = await import('./core/index.ts')
const { registerIpcHandlers, focusedTerminalId, originTerminalId, USER_ACTOR_ID, quoteWin32CmdArg } = await import('./ipc.ts')
const { registerCommands } = await import('./commands/index.ts')
const { TerminalManager: TerminalManagerClass } = await import('./terminals.ts')
const { TerminalSnapshots: TerminalSnapshotsClass } = await import('./terminalSnapshots.ts')
const { CoordinationStore: CoordinationStoreClass } = await import('./coordination.ts')
const { PlannerStore: PlannerStoreClass } = await import('./plannerStore.ts')
const { BrainStore: BrainStoreClass } = await import('./brain.ts')
const { CanvasStore: CanvasStoreClass } = await import('./canvasState.ts')
const { AppState: AppStateClass } = await import('./appState.ts')

after(() => {
  delete process.env.ORCSPACE_TEST_USER_DATA
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('IPC Handler Registration & Methods', () => {
  let core: ReturnType<typeof createCore>
  let terminals: TerminalManager
  let snapshots: TerminalSnapshots
  let coordination: CoordinationStore
  let planner: PlannerStore
  let brain: BrainStore
  let canvas: CanvasStore
  let state: AppState

  beforeEach(() => {
    handlers.clear()
    listeners.clear()

    core = createCore()
    terminals = new TerminalManagerClass()
    snapshots = new TerminalSnapshotsClass()
    coordination = new CoordinationStoreClass(core.locks)
    planner = new PlannerStoreClass()
    brain = new BrainStoreClass()
    canvas = new CanvasStoreClass()
    state = new AppStateClass()

    registerCommands({
      core,
      canvas,
      brain,
      board: coordination,
      planner,
      terminals,
      snapshots,
      requestWidget: () => {},
      requestWidgetRemoval: () => {},
      originWidgetId: () => null,
      forgetOrigin: () => {},
      defaultCwd: () => userData
    })

    registerIpcHandlers({
      core,
      terminals,
      coordination,
      planner,
      brain,
      canvas,
      state,
      getWindow: () => null,
      getWorkspaceDir: () => userData,
      setWorkspaceDir: () => {}
    })
  })

  afterEach(() => {
    planner.dispose()
  })

  test('registers essential invoke handlers including terminal:write and terminal:dispose', () => {
    // Crucial check: terminal:write must be in handlers (ipcMain.handle), not listeners (ipcMain.on)!
    assert.ok(handlers.has('terminal:write'), 'terminal:write must be registered via ipcMain.handle')
    assert.ok(handlers.has('terminal:dispose'), 'terminal:dispose must be registered via ipcMain.handle')
    assert.ok(handlers.has('terminal:create'), 'terminal:create must be registered')
    assert.ok(handlers.has('mcp:getStatus'), 'mcp:getStatus must be registered')
    assert.ok(handlers.has('mcp:getUrl'), 'mcp:getUrl must be registered')
    assert.ok(handlers.has('mcp:restart'), 'mcp:restart must be registered')
    assert.ok(handlers.has('planner:list'), 'planner:list must be registered')
    assert.ok(handlers.has('planner:toggle'), 'planner:toggle must be registered')
  })

  test('terminal:write delegates to CommandBus and returns error for not running terminal', async () => {
    const handler = handlers.get('terminal:write')
    assert.ok(handler)

    const term = terminals.reserve({ title: 'Test Term' })
    const result = (await handler({} as any, term.id, 'echo hi\n')) as any

    // Returns unwrap error payload since terminal is not running
    assert.ok(result.error)
    assert.equal(result.code, 'failed')
  })

  test('planner:create and planner:toggle route through bus successfully', async () => {
    const createHandler = handlers.get('planner:create')
    const toggleHandler = handlers.get('planner:toggle')
    assert.ok(createHandler)
    assert.ok(toggleHandler)

    const created = (await createHandler({} as any, { title: 'Do homework', day: '2026-08-15' })) as any
    assert.ok(created.id)
    assert.equal(created.title, 'Do homework')
    assert.equal(created.done, false)

    const toggled = (await toggleHandler({} as any, created.id, true)) as any
    assert.equal(toggled.done, true)
    assert.equal(toggled.id, created.id)
  })

  test('fs handlers perform directory listing, file read/write, create and delete', async () => {
    const listHandler = handlers.get('fs:list')
    const createHandler = handlers.get('fs:create-file')
    const readHandler = handlers.get('fs:read-file')
    const deleteHandler = handlers.get('fs:delete')
    assert.ok(listHandler && createHandler && readHandler && deleteHandler)

    const targetFile = join(userData, 'sample.txt')

    // Test creating a file
    const createRes = (await createHandler({} as any, targetFile)) as any
    assert.equal(createRes.ok, true)

    // Test writing to file
    const writeHandler = handlers.get('fs:write-file')
    assert.ok(writeHandler)
    const writeRes = (await writeHandler({} as any, targetFile, 'Hello OrcSpace')) as any
    assert.equal(writeRes.ok, true)

    // Test reading the file
    const readRes = (await readHandler({} as any, targetFile)) as any
    assert.equal(readRes.content, 'Hello OrcSpace')
    assert.equal(readRes.isBinary, false)

    // Test directory listing
    const listRes = (await listHandler({} as any, userData)) as any
    assert.ok(Array.isArray(listRes.items))
    assert.ok(listRes.items.some((e: any) => e.name === 'sample.txt'))

    // Test deleting the file
    const deleteRes = (await deleteHandler({} as any, targetFile)) as any
    assert.equal(deleteRes.ok, true)

    const listResAfter = (await listHandler({} as any, userData)) as any
    assert.ok(Array.isArray(listResAfter.items))
    assert.ok(!listResAfter.items.some((e: any) => e.name === 'sample.txt'))
  })

  test('system:stats returns CPU, RAM, process info and active terminals', async () => {
    const statsHandler = handlers.get('system:stats')
    assert.ok(statsHandler)

    const stats = (await statsHandler({} as any)) as any
    assert.ok(typeof stats.cpuPercent === 'number')
    assert.ok(stats.cpuCount > 0)
    assert.ok(stats.totalMem > 0)
    assert.ok(stats.freeMem >= 0)
    assert.ok(stats.memUsagePercent >= 0 && stats.memUsagePercent <= 100)
    assert.ok(stats.processMemory.rss > 0)
    assert.ok(Array.isArray(stats.activeTerminals))
    assert.ok(stats.platform)
  })

  test('quoteWin32CmdArg keeps metacharacters inside a quoted token', () => {
    assert.equal(quoteWin32CmdArg('hello'), '"hello"')
    assert.equal(quoteWin32CmdArg('a & calc.exe'), '"a & calc.exe"')
    assert.equal(quoteWin32CmdArg('say "hi"'), '"say ""hi"""')
    assert.equal(quoteWin32CmdArg('%PATH%'), '"%%PATH%%"')
  })
})


