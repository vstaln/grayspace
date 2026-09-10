import { describe, test, beforeEach, after, before } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-cli-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

const { createCore } = await import('./core/index.ts')
const { OrchestrationStore } = await import('./orchestration/store.ts')
const { registerCommands } = await import('./commands/index.ts')
const { TerminalManager } = await import('./terminals.ts')
const { TerminalSnapshots } = await import('./terminalSnapshots.ts')
const { PlannerStore } = await import('./plannerStore.ts')
const { CanvasStore } = await import('./canvasState.ts')
const { startControlServer } = await import('./controlServer.ts')
const { controlToken } = await import('./controlToken.ts')
const { getIpcSocketPath } = await import('./ipcSocket.ts')

describe('orc CLI - Functional, Performance & Integration Tests', () => {
  let server: ReturnType<typeof startControlServer>
  let core: ReturnType<typeof createCore>
  let orchestration: InstanceType<typeof OrchestrationStore>
  let terminals: InstanceType<typeof TerminalManager>
  let planner: InstanceType<typeof PlannerStore>
  let canvas: InstanceType<typeof CanvasStore>
  let snapshots: InstanceType<typeof TerminalSnapshots>
  const cliPath = join(process.cwd(), 'cli', 'orc.mjs')
  const token = controlToken()
  const agentId = 'test-agent-1'
  const testPort = 20245

  before(async () => {
    core = createCore()
    orchestration = new OrchestrationStore({ file: join(userData, 'orchestration.json') })
    terminals = new TerminalManager()
    planner = new PlannerStore()
    canvas = new CanvasStore()
    snapshots = new TerminalSnapshots()

    registerCommands({
      core,
      canvas,
      planner,
      orchestration,
      terminals,
      snapshots,
      requestWidget: (info) => {
        const record = (terminals as unknown as { terminals: Map<string, { pty: unknown }> }).terminals?.get(info.id)
        if (record) {
          record.pty = { write: () => {}, resize: () => {}, kill: () => {} }
          terminals.emit('spawned', info.id)
        }
      },
      requestWidgetRemoval: () => {},
      originWidgetId: () => null,
      forgetOrigin: () => {},
      defaultCwd: () => userData
    })

    server = startControlServer({
      core,
      terminals,
      planner,
      orchestration,
      canvas,
      port: testPort,
      state: { workspaceDir: userData } as never,
      defaultCwd: () => userData
    })

    if (!server.listening) {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    }
  })

  beforeEach(() => {
    orchestration.reset({ all: true })
  })

  after(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    orchestration.dispose()
    planner.dispose()
    delete process.env.ORCSPACE_TEST_USER_DATA
    fs.rmSync(userData, { recursive: true, force: true })
  })
  function runOrc(args: string[], envOverrides: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string; json: unknown }> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ORCSPACE_URL: `http://127.0.0.1:${testPort}`,
      ORCSPACE_TOKEN: token,
      ORCSPACE_AGENT_ID: agentId,
      ...envOverrides
    }
    delete env.ORCSPACE_SOCKET_PATH
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === '') delete env[k]
      else env[k] = v
    }
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [cliPath, ...args, '--json'],
        {
          env,
          encoding: 'utf8'
        },
        (error, stdout, stderr) => {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(stdout)
          } catch {

          }
          const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0
          resolve({
            status: exitCode,
            stdout,
            stderr,
            json: parsed
          })
        }
      )
    })
  }

  test('whoami returns agent identification and status', async () => {
    const res = await runOrc(['whoami'])
    assert.equal(res.status, 0)
    const data = res.json as { agentId: string; busy: boolean }
    assert.equal(data.agentId, agentId)
    assert.equal(data.busy, false)
  })

  test('doctor reports reachable app, agent ID, and workspace', async () => {
    const res = await runOrc(['doctor'])
    assert.equal(res.status, 0)
    const data = res.json as { ok: boolean; agentId: string; workspace: string }
    assert.equal(data.ok, true)
    assert.equal(data.agentId, agentId)
    assert.equal(data.workspace, userData)
  })

  test('status reports run and tasks state', async () => {
    const res = await runOrc(['status'])
    assert.equal(res.status, 0)
    const data = res.json as { run: unknown; tasks: number; ready: number }
    assert.equal(data.tasks, 0)
    assert.equal(data.ready, 0)
  })

  test('full run & task lifecycle via orc CLI commands', async () => {

    const runRes = await runOrc(['run-create', '--objective', 'Test Suite Goal'])
    assert.equal(runRes.status, 0)
    const runData = runRes.json as { id: string; objective: string }
    assert.ok(runData.id.startsWith('run-'))
    assert.equal(runData.objective, 'Test Suite Goal')


    const task1Res = await runOrc(['task-create', 'Initial build spec', '--title', 'Task 1'])
    assert.equal(task1Res.status, 0)
    const task1 = task1Res.json as { id: string; status: string; title: string }
    assert.equal(task1.status, 'ready')
    assert.equal(task1.title, 'Task 1')

    const task2Res = await runOrc(['task-create', 'Dependent spec', '--title', 'Task 2', '--deps', JSON.stringify([task1.id])])
    assert.equal(task2Res.status, 0)
    const task2 = task2Res.json as { id: string; status: string }
    assert.equal(task2.status, 'pending')


    const showRes = await runOrc(['task-show', task1.id])
    assert.equal(showRes.status, 0)
    const showTask = showRes.json as { id: string; title: string; spec: string }
    assert.equal(showTask.id, task1.id)
    assert.equal(showTask.spec, 'Initial build spec')


    const listRes = await runOrc(['tasks', '--ready'])
    assert.equal(listRes.status, 0)
    const listData = listRes.json as { tasks: Array<{ id: string }> }
    assert.equal(listData.tasks.length, 1)
    assert.equal(listData.tasks[0].id, task1.id)


    const showRunRes = await runOrc(['run-show', runData.id])
    assert.equal(showRunRes.status, 0)
    const showRun = showRunRes.json as { run: { id: string }; tasks: unknown[] }
    assert.equal(showRun.run.id, runData.id)
    assert.equal(showRun.tasks.length, 2)


    const updateRes = await runOrc(['task-update', task1.id, '--status', 'blocked'])
    assert.equal(updateRes.status, 0)


    const closeRes = await runOrc(['run-close', runData.id, '--yes'])
    assert.equal(closeRes.status, 0)
  })

  test('decision gates lifecycle via orc gates commands', async () => {
    await runOrc(['run-create', '--objective', 'Gate Test'])
    const gateRes = await runOrc(['gate-create', '--question', 'Deploy to production?', '--options', '["yes","no"]'])
    assert.equal(gateRes.status, 0)
    const gate = gateRes.json as { id: string; question: string }
    assert.ok(gate.id.startsWith('gate-'))

    const gatesList = await runOrc(['gates'])
    assert.equal(gatesList.status, 0)
    const gatesData = gatesList.json as { gates: Array<{ id: string; resolvedAt?: number }> }
    assert.equal(gatesData.gates.length, 1)
    assert.equal(gatesData.gates[0].id, gate.id)

    const resolveRes = await runOrc(['gate-resolve', gate.id, 'yes'])
    assert.equal(resolveRes.status, 0)
    const resolvedGate = resolveRes.json as { id: string; resolution: string }
    assert.equal(resolvedGate.resolution, 'yes')
  })

  test('messaging, check, reply, and done flow', async () => {
    await runOrc(['run-create', '--objective', 'Messaging Test'])
    const taskRes = await runOrc(['task-create', 'Subtask for agent', '--title', 'Subtask 1'])
    const task = taskRes.json as { id: string }


    const sendRes = await runOrc(['send', '--type', 'ask', '--subject', 'Which database?', '--body', 'PostgreSQL or SQLite?'])
    assert.equal(sendRes.status, 0)
    const sent = sendRes.json as { id: string; type: string }
    assert.equal(sent.type, 'ask')


    const checkRes = await runOrc(['check', '--all'])
    assert.equal(checkRes.status, 0)
    const inbox = checkRes.json as { messages: Array<{ id: string; subject: string }> }
    assert.ok(inbox.messages.length >= 1)


    const replyRes = await runOrc(['reply', sent.id, 'Use SQLite'])
    assert.equal(replyRes.status, 0)
    const replyMsg = replyRes.json as { id: string; type: string; replyTo: string }
    assert.equal(replyMsg.type, 'reply')
    assert.equal(replyMsg.replyTo, sent.id)


    const dispRes = await runOrc(['worker-start', task.id, 'claude'])
    assert.equal(dispRes.status, 0)
    const disp = dispRes.json as { dispatchId: string }


    const doneRes = await runOrc(['done', '--outcome', 'succeeded', '--task-id', task.id, '--dispatch-id', disp.dispatchId, '--files', 'db.ts'])
    assert.equal(doneRes.status, 0)
    const doneMsg = doneRes.json as { settled?: { status: string } }
    assert.equal(doneMsg.settled?.status, 'completed')
  })

  test('planner commands with create, list, toggle, delete', async () => {
    const createRes = await runOrc(['plan', 'create', 'Refactor CLI flags', '--project', 'Core', '--note', 'High priority'])
    assert.equal(createRes.status, 0)
    const created = createRes.json as { id: string; title: string }
    assert.equal(created.title, 'Refactor CLI flags')

    const listRes = await runOrc(['plan', 'list'])
    assert.equal(listRes.status, 0)
    const listData = listRes.json as { items: Array<{ id: string }> }
    assert.ok(listData.items.some((i) => i.id === created.id))

    const toggleRes = await runOrc(['plan', 'toggle', created.id, '--done'])
    assert.equal(toggleRes.status, 0)

    const deleteRes = await runOrc(['plan', 'delete', created.id, '--yes'])
    assert.equal(deleteRes.status, 0)
  })

  test('workers roster shows what runs inside each terminal', async () => {
    const manual = terminals.reserve({ title: 'manual-1' })
    terminals.appendOutput(manual.id, '$ antigravity chat\nhello')
    let disp: { dispatchId?: string } | null = null
    try {
      await runOrc(['run-create', '--objective', 'Roster Test'])
      const taskRes = await runOrc(['task-create', 'Do the thing', '--title', 'The Thing'])
      const task = taskRes.json as { id: string }
      const dispRes = await runOrc(['worker-start', task.id, 'claude'])
      assert.equal(dispRes.status, 0)
      disp = dispRes.json as { dispatchId?: string }

      const res = await runOrc(['workers'])
      assert.equal(res.status, 0)
      const data = res.json as {
        workers: Array<{
          id: string; name: string; busy: boolean; agent?: string; running?: string
          taskTitle?: string; cwd?: string; alive?: boolean
        }>
      }
      const seen = data.workers.find((w) => w.id === manual.id)
      assert.ok(seen, 'manual terminal is listed')
      assert.equal(seen.busy, false)
      assert.equal(seen.running, '~antigravity')
      assert.equal(typeof seen.cwd, 'string')
      const dispatched = data.workers.find((w) => w.agent === 'claude')
      assert.ok(dispatched, 'dispatched worker is listed with its agent')
      assert.equal(dispatched.running, 'claude')
      assert.equal(dispatched.taskTitle, 'The Thing')
    } finally {
      if (disp?.dispatchId) {
        await runOrc(['worker-release', disp.dispatchId])
      }
      terminals.dispose(manual.id)
    }
  })

  test('orc tell command routes text to worker', async () => {
    const term = terminals.reserve({ title: 'worker-2' })
    const record = (terminals as unknown as { terminals: Map<string, { pty: unknown }> }).terminals?.get(term.id)
    if (record) {
      record.pty = {
        write: (data: string) => {
          if (data === '\r') return true
          setImmediate(() => {
            terminals.appendOutput(term.id, data)
            terminals.emit('data', term.id, data)
          })
          return true
        },
        resize: () => {},
        kill: () => {}
      }
      terminals.emit('spawned', term.id)
    }
    const tellRes = await runOrc(['tell', 'worker-2', 'echo hello'])
    assert.equal(tellRes.status, 0)
    assert.equal((tellRes.json as { delivery?: { status?: string } }).delivery?.status, 'delivered')
    terminals.dispose(term.id)
  })

  if (process.platform === 'win32') {
    test('Windows orc.cmd batch shim executes correctly with ORCSPACE_NODE', async () => {
      const cmdPath = join(process.cwd(), 'cli', 'orc.cmd')
      const res = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
        execFile(
          'cmd.exe',
          ['/c', cmdPath, 'whoami', '--json'],
          {
            env: {
              ...process.env,
              ORCSPACE_URL: `http://127.0.0.1:${testPort}`,
              ORCSPACE_TOKEN: token,
              ORCSPACE_AGENT_ID: agentId,
              ORCSPACE_NODE: process.execPath
            },
            encoding: 'utf8'
          },
          (error, stdout, stderr) => {
            const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0
            resolve({ status: exitCode, stdout, stderr })
          }
        )
      })

      assert.equal(res.status, 0, `orc.cmd failed: ${res.stderr}`)
      const parsed = JSON.parse(res.stdout) as { agentId: string }
      assert.equal(parsed.agentId, agentId)
    })

    test('Windows orc.cmd batch shim executes correctly without ORCSPACE_NODE', async () => {
      const cmdPath = join(process.cwd(), 'cli', 'orc.cmd')
      const env: Record<string, string | undefined> = { ...process.env, ORCSPACE_URL: `http://127.0.0.1:${testPort}`, ORCSPACE_TOKEN: token, ORCSPACE_AGENT_ID: agentId }
      delete env.ORCSPACE_NODE
      const res = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
        execFile(
          'cmd.exe',
          ['/c', cmdPath, 'whoami', '--json'],
          {
            env,
            encoding: 'utf8'
          },
          (error, stdout, stderr) => {
            const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0
            resolve({ status: exitCode, stdout, stderr })
          }
        )
      })

      assert.equal(res.status, 0, `orc.cmd failed: ${res.stderr}`)
      const parsed = JSON.parse(res.stdout) as { agentId: string }
      assert.equal(parsed.agentId, agentId)
    })
  }

  test('communicates directly over Named Pipe / IPC socket without TCP port', async () => {
    const pipePath = getIpcSocketPath()
    const res = await runOrc(['whoami'], {
      ORCSPACE_URL: '',
      WORKSPACE_CONTROL_PORT: '',
      ORCSPACE_SOCKET_PATH: pipePath
    })
    assert.equal(res.status, 0, `whoami over pipe failed: ${res.stderr}`)
    const json = res.json as { agentId: string; busy: boolean }
    assert.equal(json.agentId, agentId)
    assert.equal(json.busy, false)
  })
})
