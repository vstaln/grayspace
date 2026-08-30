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
const { CoordinationStore } = await import('./coordination.ts')
const { PlannerStore } = await import('./plannerStore.ts')
const { CanvasStore } = await import('./canvasState.ts')
const { startControlServer } = await import('./controlServer.ts')
const { controlToken } = await import('./controlToken.ts')

describe('orc CLI - Functional, Performance & Integration Tests', () => {
  let server: ReturnType<typeof startControlServer>
  let core: ReturnType<typeof createCore>
  let orchestration: InstanceType<typeof OrchestrationStore>
  let terminals: InstanceType<typeof TerminalManager>
  let coordination: InstanceType<typeof CoordinationStore>
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
    coordination = new CoordinationStore(core.locks)
    planner = new PlannerStore()
    canvas = new CanvasStore()
    snapshots = new TerminalSnapshots()

    registerCommands({
      core,
      canvas,
      board: coordination,
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
      coordination,
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
    coordination.dispose()
    delete process.env.ORCSPACE_TEST_USER_DATA
    fs.rmSync(userData, { recursive: true, force: true })
  })

  function runOrc(args: string[], envOverrides: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string; json: unknown }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [cliPath, ...args, '--json'],
        {
          env: {
            ...process.env,
            ORCSPACE_URL: `http://127.0.0.1:${testPort}`,
            ORCSPACE_TOKEN: token,
            ORCSPACE_AGENT_ID: agentId,
            ...envOverrides
          },
          encoding: 'utf8'
        },
        (error, stdout, stderr) => {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(stdout)
          } catch {
            /* ignore */
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
    // 1. Create a run
    const runRes = await runOrc(['run-create', '--objective', 'Test Suite Goal'])
    assert.equal(runRes.status, 0)
    const runData = runRes.json as { id: string; objective: string }
    assert.ok(runData.id.startsWith('run-'))
    assert.equal(runData.objective, 'Test Suite Goal')

    // 2. Create tasks with dependencies (using positional and flag args)
    const task1Res = await runOrc(['task-create', 'Initial build spec', '--title', 'Task 1'])
    assert.equal(task1Res.status, 0)
    const task1 = task1Res.json as { id: string; status: string; title: string }
    assert.equal(task1.status, 'ready')
    assert.equal(task1.title, 'Task 1')

    const task2Res = await runOrc(['task-create', 'Dependent spec', '--title', 'Task 2', '--deps', JSON.stringify([task1.id])])
    assert.equal(task2Res.status, 0)
    const task2 = task2Res.json as { id: string; status: string }
    assert.equal(task2.status, 'pending')

    // 3. Inspect task details with task-show
    const showRes = await runOrc(['task-show', task1.id])
    assert.equal(showRes.status, 0)
    const showTask = showRes.json as { id: string; title: string; spec: string }
    assert.equal(showTask.id, task1.id)
    assert.equal(showTask.spec, 'Initial build spec')

    // 4. List tasks with alias
    const listRes = await runOrc(['tasks', '--ready'])
    assert.equal(listRes.status, 0)
    const listData = listRes.json as { tasks: Array<{ id: string }> }
    assert.equal(listData.tasks.length, 1)
    assert.equal(listData.tasks[0].id, task1.id)

    // 5. Inspect run with run-show
    const showRunRes = await runOrc(['run-show', runData.id])
    assert.equal(showRunRes.status, 0)
    const showRun = showRunRes.json as { run: { id: string }; tasks: unknown[] }
    assert.equal(showRun.run.id, runData.id)
    assert.equal(showRun.tasks.length, 2)

    // 6. Update task status
    const updateRes = await runOrc(['task-update', task1.id, '--status', 'blocked'])
    assert.equal(updateRes.status, 0)

    // 7. Close run
    const closeRes = await runOrc(['run-close', runData.id])
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

    // Send direct message
    const sendRes = await runOrc(['send', '--type', 'ask', '--subject', 'Which database?', '--body', 'PostgreSQL or SQLite?'])
    assert.equal(sendRes.status, 0)
    const sent = sendRes.json as { id: string; type: string }
    assert.equal(sent.type, 'ask')

    // Check inbox with orc check
    const checkRes = await runOrc(['check', '--all'])
    assert.equal(checkRes.status, 0)
    const inbox = checkRes.json as { messages: Array<{ id: string; subject: string }> }
    assert.ok(inbox.messages.length >= 1)

    // Reply to the question
    const replyRes = await runOrc(['reply', sent.id, 'Use SQLite'])
    assert.equal(replyRes.status, 0)
    const replyMsg = replyRes.json as { id: string; type: string; replyTo: string }
    assert.equal(replyMsg.type, 'reply')
    assert.equal(replyMsg.replyTo, sent.id)

    // Dispatch task onto a worker
    const dispRes = await runOrc(['worker-start', task.id, 'claude'])
    assert.equal(dispRes.status, 0)
    const disp = dispRes.json as { dispatchId: string }

    // Send done report with dispatchId
    const doneRes = await runOrc(['done', '--outcome', 'succeeded', '--task-id', task.id, '--dispatch-id', disp.dispatchId, '--files', 'db.ts'])
    assert.equal(doneRes.status, 0)
    const doneMsg = doneRes.json as { settled?: { status: string } }
    assert.equal(doneMsg.settled?.status, 'completed')
  })

  test('kanban board commands with positional claim and update', async () => {
    const createRes = await runOrc(['board', 'create', 'Refactor engine', '--brief', 'Clean up handlers'])
    assert.equal(createRes.status, 0)
    const created = createRes.json as { id: string; title: string }
    const taskId = created.id
    assert.ok(taskId)

    const claimRes = await runOrc(['board', 'claim', taskId])
    assert.equal(claimRes.status, 0)

    const updateRes = await runOrc(['board', 'update', taskId, 'done'])
    assert.equal(updateRes.status, 0)
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

    const deleteRes = await runOrc(['plan', 'delete', created.id])
    assert.equal(deleteRes.status, 0)
  })
})
