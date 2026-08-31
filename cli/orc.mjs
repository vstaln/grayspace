#!/usr/bin/env node
/**
 * `orc` — the OrcSpace agent CLI.
 *
 * This is the whole reason OrcSpace needs no protocol between agents. A CLI
 * coding agent already has one universal tool: the shell. So instead of
 * teaching it a transport, we hand it a command. Everything below is a thin,
 * highly-optimized RPC client for the loopback control server the app already runs —
 * it holds no state, needs no configuration, and dies with the command.
 *
 * Identity comes from the environment the app spawned the terminal with, so a
 * worker never has to know or invent an agent id:
 *
 *   ORCSPACE_URL       http://127.0.0.1:<port>
 *   ORCSPACE_TOKEN     the control token
 *   ORCSPACE_AGENT_ID  this terminal's id — the worker's actor id
 *
 * Output is human-readable by default and JSON with `--json`, because both
 * consumers matter: the model reads it, and so does the person watching.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const TOKEN_HEADER = 'x-orcspace-token'

/**
 * Fast-path token discovery:
 * When running inside an OrcSpace terminal, ORCSPACE_TOKEN is always present in env.
 * We return it immediately with ZERO disk I/O.
 * If not set, we lazily probe known candidate directories in priority order and stop
 * at the first valid token found.
 */
function getCandidateTokens() {
  const envToken = (process.env.ORCSPACE_TOKEN || '').trim()
  if (envToken.length >= 32) {
    return [envToken]
  }
  return getAllCandidateTokens(true)
}

function getAllCandidateTokens(stopAtFirst = false) {
  const tokens = []
  const envToken = (process.env.ORCSPACE_TOKEN || '').trim()
  if (envToken.length >= 32) {
    tokens.push(envToken)
    if (stopAtFirst) return tokens
  }

  const candidateDirs = [
    path.join(process.cwd(), '.dev-user-data'),
    process.env.ORCSPACE_DEV_USER_DATA,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'OrcSpace') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Orcspace') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'com.orcspace.app') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OrcSpace') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Orcspace') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'com.orcspace.app') : null,
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev-user-data'),
    path.join(os.homedir(), '.config', 'OrcSpace'),
    path.join(os.homedir(), '.config', 'Orcspace'),
    path.join(os.homedir(), '.config', 'orcspace'),
    path.join(os.homedir(), 'Library', 'Application Support', 'OrcSpace'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Orcspace')
  ].filter(Boolean)

  for (const dir of candidateDirs) {
    try {
      const tokenPath = path.join(dir, 'control-token')
      if (fs.existsSync(tokenPath)) {
        const content = fs.readFileSync(tokenPath, 'utf8').trim()
        if (content.length >= 32 && !tokens.includes(content)) {
          tokens.push(content)
          if (stopAtFirst) return tokens
        }
      }
    } catch {
      /* try next candidate */
    }
  }
  return tokens
}

const BASE = (process.env.ORCSPACE_URL || 'http://127.0.0.1:20220').replace(/\/+$/, '')
const AGENT_ID = process.env.ORCSPACE_AGENT_ID || process.env.ORCSPACE_TERMINAL_ID || 'cli'
let workingToken = null

// ---------------------------------------------------------------- arg parsing

/**
 * Flags are `--kebab-case value`, `--flag` (boolean) and `--no-flag` (false).
 * Deliberately permissive: a model that writes `--task-id` where the doc says
 * `--task` should get the call through, not a usage error.
 */
function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags[camel(body.slice(0, eq))] = body.slice(eq + 1)
      continue
    }
    if (body.startsWith('no-')) {
      flags[camel(body.slice(3))] = false
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[camel(body)] = true
    } else {
      flags[camel(body)] = next
      i += 1
    }
  }
  return { flags, positional }
}

const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

/** First flag present out of several spellings a model might reach for. */
function pick(flags, ...names) {
  for (const name of names) {
    if (flags[name] !== undefined) return flags[name]
  }
  return undefined
}

/** `--files "a.ts,b.ts"` or `--files '["a.ts"]'` — accept both. */
function list(value) {
  if (value === undefined || value === true) return undefined
  if (Array.isArray(value)) return value.map(String)
  const text = String(value).trim()
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      /* fall through to comma splitting */
    }
  }
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const int = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

// ------------------------------------------------------------------ transport

class OrcError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

async function call(method, path, body, options = {}) {
  let candidateTokens = workingToken ? [workingToken] : getCandidateTokens()
  if (candidateTokens.length === 0) {
    throw new OrcError(
      'OrcSpace control token not found — ensure OrcSpace is running.',
      'no_token'
    )
  }

  const url = `${BASE}${path}`
  let lastError = null

  for (let i = 0; i < candidateTokens.length; i++) {
    const token = candidateTokens[i]
    try {
      let response
      const timeoutMs = options.timeoutMs ?? (options.signal ? undefined : 15_000)
      const signal = options.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined)

      try {
        response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            [TOKEN_HEADER]: token
          },
          keepalive: true,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(signal ? { signal } : {})
        })
      } catch (fetchErr) {
        if (fetchErr.name === 'TimeoutError' || fetchErr.code === 23) {
          throw new OrcError(
            `OrcSpace request timed out after ${Math.round((timeoutMs || 15000) / 1000)}s for ${path}`,
            'timeout'
          )
        }
        throw new OrcError(
          `OrcSpace is not reachable at ${BASE} — is the app running? (${fetchErr.message})`,
          'offline'
        )
      }

      if (response.status === 401) {
        workingToken = null
        if (i === 0 && candidateTokens.length === 1) {
          const allTokens = getAllCandidateTokens(false)
          if (allTokens.length > 1) {
            candidateTokens = allTokens
            continue
          }
        }
        if (candidateTokens.length > 1 && i < candidateTokens.length - 1) {
          continue
        }
      }

      workingToken = token

      const isJson = (response.headers.get('content-type') || '').includes('application/json')
      const payload = isJson ? await response.json() : await response.text()

      if (!response.ok) {
        const message = typeof payload === 'object' && payload?.error ? payload.error : `HTTP ${response.status}`
        const code = typeof payload === 'object' && payload?.code ? payload.code : `http_${response.status}`
        throw new OrcError(message, code)
      }

      return payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload
    } catch (err) {
      if (err instanceof OrcError && err.code === 'http_401' && candidateTokens.length > 1) {
        continue
      }
      lastError = err
      break
    }
  }

  if (lastError) throw lastError
  throw new OrcError('a valid control token is required', 'http_401')
}

const get = (path, params = {}, options = {}) => call('GET', withQuery(path, params), undefined, options)
const post = (path, body = {}, options = {}) => call('POST', path, { agentId: AGENT_ID, ...body }, options)
const patch = (path, body = {}, options = {}) => call('PATCH', path, { agentId: AGENT_ID, ...body }, options)

function withQuery(path, params) {
  const query = new URLSearchParams()
  if (AGENT_ID) query.set('agentId', AGENT_ID)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    query.set(key, value === true ? '1' : String(value))
  }
  const qs = query.toString()
  return qs ? `${path}?${qs}` : path
}

/**
 * A long poll can run for fifteen minutes. Emitting a heartbeat line to stderr
 * keeps the agent's terminal visibly alive without polluting stdout, which
 * stays reserved for the single JSON result the caller parses.
 */
function beat(label) {
  const started = Date.now()
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000)
    process.stderr.write(`${JSON.stringify({ waiting: label, seconds })}\n`)
  }, 15_000)
  timer.unref?.()
  return () => clearInterval(timer)
}

// -------------------------------------------------------------------- output

let asJson = false

function emit(value, human) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  process.stdout.write(`${human ? human(value) : JSON.stringify(value, null, 2)}\n`)
}

const taskLine = (t) => `  ${t.id}  [${t.status}]  ${t.title}${t.deps?.length ? `  deps=${t.deps.join(',')}` : ''}`
const dispatchLine = (d) =>
  `  ${d.id}  ${d.state}${d.outcome ? `/${d.outcome}` : ''}  task=${d.taskId}  term=${d.terminalId}  ${d.agent}`
const messageLine = (m) =>
  `  ${m.id}  ${m.type}  from=${m.from}${m.taskId ? ` task=${m.taskId}` : ''}${m.outcome ? ` outcome=${m.outcome}` : ''}\n    ${m.subject}${m.body ? `\n    ${m.body.split('\n').join('\n    ')}` : ''}`

// ------------------------------------------------------------------ commands

const HELP = `orc — OrcSpace agent CLI

THE OTHER AGENTS & ROSTER
  orc whoami                                  identify your own agent, terminal & task
  orc workers | orc ps | orc who              who else is open on the canvas (* marks you)
  orc rename [<worker>] [--name <name>]       rename a terminal (canvas title = worker name)
  orc tell <worker> "run the tests"           type directly into another agent's terminal
  Workers are addressed by name anywhere --to is taken: a name, @name, a
  case-insensitive or unambiguous prefix, the terminal id, or "self".

COORDINATION & RUNS
  orc status | orc st                         summary of open run, tasks, live workers, unread mail
  orc run-create --objective "..."            open a run (namespace + coordinator inbox)
  orc run-list | orc runs                     list all runs, newest first
  orc run-show [<id>] | orc run [<id>]        inspect details of a run and its tasks
  orc run-close [<id>]                        close a run

TASKS & DAG
  orc task-create [<spec>] [--title "..."]    file a task into the active run
                           [--deps '["otask-1"]']
  orc task-list | orc tasks [--ready]         list tasks; --ready = ready to dispatch
  orc task-show [<id>] | orc task [<id>]      view full specification and details of a task
  orc task-update [<id>] [--status <s>]       update a task's status, title, or spec

DISPATCH & WORKERS
  orc worker-start [<taskId>] [--agent claude|codex|cursor|opencode]
                              [--terminal <id>] [--command "..."] [--no-inject]
  orc dispatch [<taskId>] --to <terminalId>   dispatch work into an existing terminal
  orc worker-show [<dispatchId>]              view details/preamble of a dispatch
  orc worker-read [<dispatchId>] [--limit N]  read tail output of a worker terminal
  orc logs [<dispatchId|terminalId>] [limit]  shortcut to read worker output
  orc worker-release [<dispatchId>] [--close] release worker (optionally close terminal)
  orc worker-retain [<dispatchId>]            retain worker for subsequent tasks

INBOX, QUESTIONS & DECISION GATES
  orc check | orc inbox [--wait] [--types ...] check coordinator mail (--wait blocks)
                        [--ack <msgId>] [--all]
  orc reply [<askId>] [<bodyText>]            answer a worker's pending question
  orc gate-create --question "..."            open a decision gate (blocks dependent task)
                  [--task <t>] [--options '["a","b"]']
  orc gate-list | orc gates                   list all decision gates and resolutions
  orc gate-resolve [<gateId>] [<resolution>]  resolve a gate and unblock its task

WORKER (dispatched agent reporting)
  orc done --outcome succeeded|failed         report completion with modified files
           [--task-id <t>] [--dispatch-id <d>] [--body "..."] [--files "a.ts,b.ts"]
  orc ask --question "..." [--options "a,b"]  ask question and block until reply arrives
  orc escalate --body "..."                   escalate an issue to the coordinator
  orc heartbeat                               keep worker activity alive
  orc send --type <t> [--to <who>]            send direct message or broadcast

THE APP & CANVAS
  orc board list | claim [<id>] | update [<id>] <state>   kanban board management
  orc plan list | create | update | toggle [<id>]         planner day tasks
  orc brain list | read [<id>] | search <q> | save        second brain notes
  orc canvas list | place | move | rename | close         canvas widgets & viewport
  orc terminal open | send <id> <text> | read | close     direct terminal management
  orc git status | commit --message "..."                 git audit integration
  orc journal [--since N]                                 event audit log
  orc doctor                                              diagnostics & connectivity check
  orc api <METHOD> <path> [json]                          direct REST escape hatch

Add --json to any command for machine-readable output.`

async function main(argv) {
  const { flags, positional } = parseArgs(argv)
  asJson = flags.json === true
  const command = positional[0]

  if (!command || flags.help || command === 'help') {
    process.stdout.write(`${HELP}\n`)
    return
  }

  switch (command) {
    // ---- identity & diagnostics ---------------------------------------
    case 'whoami': {
      const [workersData, snapshot] = await Promise.all([
        get('/orchestration/workers'),
        get('/orchestration')
      ])
      const selfWorker = workersData.workers?.find((w) => w.self || w.id === AGENT_ID || w.name === AGENT_ID)
      const activeDispatch = snapshot.dispatches?.find(
        (d) => (d.terminalId === AGENT_ID || d.agent === AGENT_ID || d.terminalId === selfWorker?.id) && d.state === 'running'
      )
      const activeTask = activeDispatch ? snapshot.tasks?.find((t) => t.id === activeDispatch.taskId) : null
      const me = {
        agentId: AGENT_ID,
        name: selfWorker?.name ?? AGENT_ID,
        terminalId: selfWorker?.id ?? AGENT_ID,
        role: selfWorker?.agent ?? 'worker',
        busy: selfWorker?.busy ?? !!activeDispatch,
        taskId: activeTask?.id ?? activeDispatch?.taskId ?? null,
        taskTitle: activeTask?.title ?? null,
        dispatchId: activeDispatch?.id ?? null
      }
      return emit(me, (m) =>
        [
          `You are: ${m.name}${m.name !== m.terminalId ? ` (${m.terminalId})` : ''}`,
          `Agent ID: ${m.agentId}`,
          `Status: ${m.busy ? `busy on task ${m.taskId}${m.taskTitle ? ` ("${m.taskTitle}")` : ''}` : 'idle'}`,
          m.dispatchId ? `Dispatch ID: ${m.dispatchId}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      )
    }

    case 'doctor': {
      const [presence, orchestration, workers] = await Promise.all([
        get('/presence'),
        get('/orchestration'),
        get('/orchestration/workers')
      ])
      const result = {
        ok: true,
        app: BASE,
        agentId: AGENT_ID || null,
        workspace: presence.workspaceDir || null,
        workers: workers.workers?.length ?? 0,
        runs: orchestration.runs?.filter((r) => !r.closedAt).length ?? 0
      }
      return emit(result, (d) =>
        [
          `OrcSpace: reachable at ${d.app}`,
          `Agent: ${d.agentId || '(not inside an OrcSpace terminal)'}`,
          `Workspace: ${d.workspace || '(none)'}`,
          `Mode: native orc CLI & orchestration`,
          `Workers: ${d.workers} | open runs: ${d.runs}`
        ].join('\n')
      )
    }

    case 'status':
    case 'st': {
      const [snapshot, inbox] = await Promise.all([
        get('/orchestration'),
        get('/orchestration/inbox', { limit: 200 })
      ])
      const active = snapshot.runs.find((r) => !r.closedAt)
      const running = snapshot.dispatches.filter((d) => d.state === 'running')
      const unaccounted = snapshot.dispatches.filter((d) => d.state === 'settled')
      const readyTasks = snapshot.tasks.filter((t) => t.status === 'ready')
      const completedTasks = snapshot.tasks.filter((t) => t.status === 'completed')
      const failedTasks = snapshot.tasks.filter((t) => t.status === 'failed')
      const openGates = snapshot.gates.filter((g) => !g.resolvedAt)

      const summary = {
        run: active ?? null,
        tasks: snapshot.tasks.length,
        ready: readyTasks.length,
        completed: completedTasks.length,
        failed: failedTasks.length,
        running: running.length,
        unaccounted: unaccounted.map((d) => d.id),
        unread: inbox.messages.length,
        openGates: openGates.length
      }
      return emit(summary, (s) =>
        [
          s.run ? `run ${s.run.id} — ${s.run.objective}` : 'no open run',
          `  tasks: ${s.tasks} total (${s.ready} ready, ${s.completed} completed${s.failed ? `, ${s.failed} failed` : ''})`,
          `  workers running: ${s.running}`,
          s.unaccounted.length ? `  settled, awaiting decision: ${s.unaccounted.join(', ')}` : '',
          `  unread mail: ${s.unread}`,
          s.openGates ? `  open decision gates: ${s.openGates}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      )
    }

    // ---- runs ----------------------------------------------------------
    case 'run-create': {
      const objective = require1(pick(flags, 'objective', 'o') ?? positional[1], 'run-create needs --objective "..."')
      return emit(await post('/orchestration/runs', { objective }), (r) => `run ${r.id} — ${r.objective}`)
    }
    case 'run-list':
    case 'runs': {
      const data = await get('/orchestration/runs')
      return emit(data, (d) =>
        d.runs.length
          ? d.runs.map((r) => `  ${r.id}${r.closedAt ? ' (closed)' : ' (active)'}  ${r.objective}`).join('\n')
          : 'no runs yet — orc run-create --objective "..."'
      )
    }
    case 'run-show':
    case 'run': {
      const id = require1(pick(flags, 'id', 'run', 'runId') ?? positional[1], 'run-show needs <run-id>')
      let run
      try {
        const single = await get(`/orchestration/runs/${enc(id)}`)
        run = single.run
      } catch {
        const listData = await get('/orchestration/runs')
        run = listData.runs.find((r) => r.id === id)
      }
      if (!run) throw new OrcError(`no run "${id}"`, 'not_found')
      const tasksData = await get('/orchestration/tasks', { runId: id })
      return emit({ run, tasks: tasksData.tasks }, ({ run: r, tasks: ts }) =>
        [
          `Run: ${r.id}${r.closedAt ? ' (closed)' : ' (active)'}`,
          `Objective: ${r.objective}`,
          `Coordinator: ${r.coordinator}`,
          `Tasks (${ts.length}):`,
          ts.length ? ts.map(taskLine).join('\n') : '  (no tasks)'
        ].join('\n')
      )
    }
    case 'run-close': {
      const id = require1(pick(flags, 'id', 'run') ?? positional[1], 'run-close needs <run-id>')
      return emit(await post(`/orchestration/runs/${enc(id)}/close`), (r) => `run ${r.id} closed`)
    }

    // ---- tasks ---------------------------------------------------------
    case 'task-create': {
      const spec = require1(pick(flags, 'spec', 'brief', 'body') ?? positional[1], 'task-create needs <spec>')
      const created = await post('/orchestration/tasks', {
        spec,
        title: pick(flags, 'taskTitle', 'title'),
        deps: list(pick(flags, 'deps', 'dep')),
        runId: pick(flags, 'run', 'runId')
      })
      return emit(created, (t) => `task ${t.id} [${t.status}] ${t.title}`)
    }
    case 'task-list':
    case 'tasks': {
      const data = await get('/orchestration/tasks', {
        runId: pick(flags, 'run', 'runId'),
        status: pick(flags, 'status'),
        ready: flags.ready === true
      })
      return emit(data, (d) => (d.tasks.length ? d.tasks.map(taskLine).join('\n') : '  (no tasks)'))
    }
    case 'task-show':
    case 'task': {
      const id = require1(pick(flags, 'id', 'task', 'taskId') ?? positional[1], 'task-show needs <task-id>')
      let found
      try {
        const single = await get(`/orchestration/tasks/${enc(id)}`)
        found = single.task
      } catch {
        const data = await get('/orchestration/tasks', { runId: pick(flags, 'run', 'runId') })
        found = data.tasks.find((t) => t.id === id)
      }
      if (!found) throw new OrcError(`no task "${id}"`, 'not_found')
      return emit(found, (t) =>
        [
          `Task: ${t.id} [${t.status}]`,
          `Title: ${t.title}`,
          `Run: ${t.runId}`,
          t.deps?.length ? `Dependencies: ${t.deps.join(', ')}` : 'Dependencies: none',
          t.outcome ? `Outcome: ${t.outcome}` : '',
          `Created by: ${t.createdBy}`,
          `Specification:`,
          `  ${t.spec.split('\n').join('\n  ')}`
        ]
          .filter(Boolean)
          .join('\n')
      )
    }
    case 'task-update': {
      const id = require1(pick(flags, 'id', 'task', 'taskId') ?? positional[1], 'task-update needs <task-id>')
      return emit(
        await patch(`/orchestration/tasks/${enc(id)}`, {
          status: pick(flags, 'status'),
          title: pick(flags, 'title'),
          spec: pick(flags, 'spec')
        }),
        (t) => `task ${t.id} → ${t.status}`
      )
    }

    // ---- dispatch ------------------------------------------------------
    case 'worker-start':
    case 'dispatch': {
      const taskId = require1(pick(flags, 'task', 'taskId', 'id') ?? positional[1], `${command} needs <task-id>`)
      const started = await post('/orchestration/dispatches', {
        taskId,
        terminalId: pick(flags, 'to', 'terminal', 'terminalId'),
        agent: pick(flags, 'agent') ?? positional[2],
        command: pick(flags, 'command'),
        inject: flags.inject === false ? false : undefined
      })
      return emit(
        started,
        (d) =>
          `dispatch ${d.dispatchId} — task ${d.taskId} → terminal ${d.terminalId} (${d.agent})` +
          (d.injected ? '' : '\n  preamble NOT injected — type it into the terminal yourself')
      )
    }
    case 'worker-release':
    case 'worker-retain': {
      const id = require1(pick(flags, 'dispatch', 'dispatchId', 'id') ?? positional[1], `${command} needs <dispatch-id>`)
      return emit(
        await post(`/orchestration/dispatches/${enc(id)}/account`, {
          state: command === 'worker-retain' ? 'retained' : 'released',
          closeTerminal: flags.close === true
        }),
        (d) => `dispatch ${d.id} → ${d.state}`
      )
    }
    case 'worker-show': {
      const id = require1(pick(flags, 'dispatch', 'dispatchId', 'id') ?? positional[1], 'worker-show needs <dispatch-id>')
      let found
      try {
        const single = await get(`/orchestration/dispatches/${enc(id)}`)
        found = single.dispatch
      } catch {
        const data = await get('/orchestration/dispatches')
        found = data.dispatches.find((d) => d.id === id)
      }
      if (!found) throw new OrcError(`no dispatch "${id}"`, 'not_found')
      if (flags.preamble) return emit({ preamble: found.preamble }, (p) => p.preamble)
      return emit(found, dispatchLine)
    }
    case 'worker-read':
    case 'logs':
    case 'tail': {
      const target = require1(pick(flags, 'dispatch', 'dispatchId', 'id', 'terminal') ?? positional[1], `${command} needs <dispatch-id|terminal-id>`)
      let terminalId = target
      if (target.startsWith('disp-')) {
        let found
        try {
          const single = await get(`/orchestration/dispatches/${enc(target)}`)
          found = single.dispatch
        } catch {
          const data = await get('/orchestration/dispatches')
          found = data.dispatches.find((d) => d.id === target)
        }
        if (!found) throw new OrcError(`no dispatch "${target}"`, 'not_found')
        terminalId = found.terminalId
      }
      const limitLines = int(pick(flags, 'limit') ?? positional[2], 50)
      const output = await get(`/terminal/${enc(terminalId)}/output`, { full: '1' })
      const lines = String(output.output || '').split('\n')
      const tailOutput = lines.slice(-limitLines).join('\n')
      return emit({ target, terminalId, output: tailOutput }, (o) => o.output)
    }
    case 'dispatch-show': {
      const data = await get('/orchestration/dispatches', { taskId: pick(flags, 'task', 'taskId') ?? positional[1] })
      return emit(data, (d) => (d.dispatches.length ? d.dispatches.map(dispatchLine).join('\n') : '  (none)'))
    }

    // ---- mail ----------------------------------------------------------
    case 'send':
    case 'mail':
    case 'msg':
      return emit(await sendMessage(flags, require1(pick(flags, 'type') ?? positional[1], 'send needs --type <type>')), (m) => `sent ${m.id}`)

    case 'done': {
      const result = await sendMessage(flags, 'worker_done', {
        outcome: require1(pick(flags, 'outcome') ?? positional[1], 'done needs --outcome succeeded|failed'),
        filesModified: list(pick(flags, 'files', 'filesModified'))
      })
      return emit(result, (m) =>
        `worker_done sent (${m.id})` +
        (m.settled ? `\n  task ${m.settled.taskId} → ${m.settled.status}` : '') +
        (m.settled?.promoted?.length ? `\n  now ready: ${m.settled.promoted.join(', ')}` : '')
      )
    }
    case 'escalate':
      return emit(await sendMessage(flags, 'escalation'), (m) => `escalation sent (${m.id})`)
    case 'heartbeat':
      return emit(await sendMessage(flags, 'heartbeat'), (m) => `heartbeat sent (${m.id})`)

    case 'ask': {
      const question = require1(pick(flags, 'question', 'body', 'q') ?? positional[1], 'ask needs --question "..."')
      const asked = await sendMessage(flags, 'ask', {
        body: question,
        subject: pick(flags, 'subject') || 'question',
        options: list(pick(flags, 'options'))
      })
      const timeoutMs = int(pick(flags, 'timeoutMs'), 600_000)
      const stop = beat(`reply to ${asked.id}`)
      try {
        const { reply: answer } = await get(`/orchestration/replies/${enc(asked.id)}`, {
          wait: true,
          timeoutMs
        }, { timeoutMs: timeoutMs + 10_000 })
        if (!answer) {
          throw new OrcError(
            `no reply within ${Math.round(timeoutMs / 1000)}s — the question is still pending as ${asked.id}; ` +
              `resume with: orc check --wait --types reply`,
            'timeout'
          )
        }
        return emit(answer, (m) => `reply from ${m.from}:\n${m.body}`)
      } finally {
        stop()
      }
    }

    case 'reply': {
      const askId = require1(pick(flags, 'id', 'replyTo', 'message') ?? positional[1], 'reply needs <ask-id>')
      const replyBody = pick(flags, 'body', 'text', 'message') ?? positional[2]
      return emit(
        await sendMessage(flags, 'reply', {
          replyTo: askId,
          body: replyBody,
          to: pick(flags, 'to') || (await lookupSender(askId)),
          subject: pick(flags, 'subject') || 'reply'
        }),
        (m) => `replied (${m.id})`
      )
    }

    case 'check':
    case 'inbox': {
      const ackId = pick(flags, 'ack')
      if (typeof ackId === 'string') await post(`/orchestration/messages/${enc(ackId)}/ack`, {})
      const timeoutMs = int(pick(flags, 'timeoutMs'), 900_000)
      const params = {
        runId: pick(flags, 'run', 'runId'),
        types: Array.isArray(pick(flags, 'types')) ? pick(flags, 'types').join(',') : pick(flags, 'types'),
        all: flags.all === true,
        limit: pick(flags, 'limit'),
        wait: flags.wait === true,
        timeoutMs: flags.wait === true ? timeoutMs : undefined
      }
      const stop = flags.wait === true ? beat('inbox') : () => {}
      try {
        const data = await get('/orchestration/inbox', params, flags.wait === true ? { timeoutMs: timeoutMs + 10_000 } : {})
        return emit(data, (d) =>
          d.messages.length
            ? d.messages.map(messageLine).join('\n')
            : d.waited
              ? '  (nothing arrived before the timeout)'
              : '  (inbox empty)'
        )
      } finally {
        stop()
      }
    }

    // ---- gates ---------------------------------------------------------
    case 'gate-create':
      return emit(
        await post('/orchestration/gates', {
          question: require1(pick(flags, 'question', 'q') ?? positional[1], 'gate-create needs --question "..."'),
          taskId: pick(flags, 'task', 'taskId'),
          options: list(pick(flags, 'options')),
          runId: pick(flags, 'run', 'runId')
        }),
        (g) => `gate ${g.id} — ${g.question}`
      )
    case 'gate-list':
    case 'gates': {
      const data = await get('/orchestration/gates', {
        runId: pick(flags, 'run', 'runId'),
        open: flags.open === true ? '1' : undefined
      })
      return emit(data, (d) =>
        d.gates.length
          ? d.gates
              .map(
                (g) =>
                  `  ${g.id}  [${g.resolvedAt ? `resolved: ${g.resolution}` : 'open'}]  ${g.question}${
                    g.options?.length ? `  (options: ${g.options.join(', ')})` : ''
                  }`
              )
              .join('\n')
          : '  (no gates)'
      )
    }
    case 'gate-resolve':
      return emit(
        await post(
          `/orchestration/gates/${enc(require1(pick(flags, 'id', 'gate') ?? positional[1], 'gate-resolve needs <gate-id>'))}/resolve`,
          {
            resolution: require1(pick(flags, 'resolution', 'answer') ?? positional[2], 'gate-resolve needs --resolution "..."')
          }
        ),
        (g) => `gate ${g.id} resolved: ${g.resolution}`
      )

    // ---- the other agents on the canvas --------------------------------
    case 'workers':
    case 'who':
    case 'ps': {
      const data = await get('/orchestration/workers')
      return emit(data, (d) =>
        d.workers.length
          ? d.workers
              .map(
                (w) =>
                  `  ${w.self ? '*' : ' '} ${w.name}${w.name === w.id ? '' : `  (${w.id})`}` +
                  `${w.busy ? `  busy: ${w.taskId}` : '  idle'}${w.agent ? `  ${w.agent}` : ''}`
              )
              .join('\n')
          : '  (no terminals open)'
      )
    }

    case 'rename': {
      const to = require1(pick(flags, 'to', 'worker', 'id') ?? positional[1], 'rename needs <worker> or --to <worker>')
      const name = require1(pick(flags, 'name', 'as', 'title') ?? positional[2], 'rename needs <new name> or --name <name>')
      return emit(await post('/orchestration/workers/rename', { to, name }), (r) => `${r.id} is now "${r.name}"`)
    }

    case 'tell': {
      const to = require1(pick(flags, 'to', 'worker') ?? positional[1], 'tell needs <worker>')
      const text = require1(pick(flags, 'text', 'message', 'body') ?? positional[2], 'tell needs "text to type"')
      return emit(await post('/orchestration/workers/tell', { to, text }), () => `typed into ${to}`)
    }

    case 'reset':
      return emit(
        await post('/orchestration/reset', {
          tasks: flags.tasks === true,
          messages: flags.messages === true,
          all: flags.all === true
        }),
        () => 'reset'
      )

    // ---- the rest of the app -------------------------------------------
    case 'canvas':
      return emit(await canvas(positional[1], flags, positional))
    case 'brain':
    case 'notes':
      return emit(await brain(positional[1], flags, positional))
    case 'plan':
      return emit(await plan(positional[1], flags, positional))
    case 'board':
      return emit(await board(positional[1], flags, positional))
    case 'claim':
      return emit(await board('claim', flags, positional))
    case 'terminal':
      return emit(await terminal(positional[1], flags, positional))
    case 'git':
      return positional[1] === 'commit'
        ? emit(await post('/git/commit', { message: require1(pick(flags, 'message', 'm') ?? positional[2], 'git commit needs --message "..."') }))
        : emit(await get('/git/status'))
    case 'journal':
      return emit(await get('/journal', { since: pick(flags, 'since') ?? positional[1] }))
    case 'api': {
      const method = String(positional[1] || 'GET').toUpperCase()
      const path = require1(positional[2], 'api needs a path, e.g. orc api GET /snapshot')
      let body
      if (positional[3]) {
        try {
          body = JSON.parse(positional[3])
        } catch {
          throw new OrcError('api: body must be valid JSON', 'invalid')
        }
      }
      return emit(await call(method, path, method === 'GET' ? undefined : { agentId: AGENT_ID, ...body }))
    }

    default:
      throw new OrcError(`unknown command "${command}" — run \`orc --help\``, 'unknown_command')
  }
}

// --------------------------------------------------------------- subdomains

async function sendMessage(flags, type, extra = {}) {
  return post('/orchestration/messages', {
    type,
    to: pick(flags, 'to'),
    subject: pick(flags, 'subject'),
    body: pick(flags, 'body', 'message'),
    taskId: pick(flags, 'taskId', 'task'),
    dispatchId: pick(flags, 'dispatchId', 'dispatch'),
    runId: pick(flags, 'run', 'runId'),
    ...extra
  })
}

/** Who sent the `ask` — fast lookup via direct endpoint with fallback */
async function lookupSender(askId) {
  try {
    const single = await get(`/orchestration/messages/${enc(askId)}`)
    if (single?.message?.from) return single.message.from
  } catch {
    /* fallback */
  }
  try {
    const snapshot = await get('/orchestration')
    return snapshot.messages.find((m) => m.id === askId)?.from
  } catch {
    return undefined
  }
}

async function canvas(action, flags, positional = []) {
  const id = pick(flags, 'id') ?? positional[2]
  switch (action) {
    case 'list':
    case undefined:
      return get('/widgets')
    case 'place':
      return post('/widgets', {
        kind: require1(pick(flags, 'kind') ?? positional[2], 'canvas place needs --kind'),
        title: pick(flags, 'title'),
        x: num(pick(flags, 'x')),
        y: num(pick(flags, 'y'))
      })
    case 'rename':
      return patch(`/widgets/${enc(require1(id, 'canvas rename needs <id>'))}`, {
        title: pick(flags, 'title') ?? positional[3]
      })
    case 'move':
      return patch(`/widgets/${enc(require1(id, 'canvas move needs <id>'))}`, {
        x: num(pick(flags, 'x')),
        y: num(pick(flags, 'y')),
        w: num(pick(flags, 'w')),
        h: num(pick(flags, 'h'))
      })
    case 'focus':
      return post('/canvas/camera', { x: num(pick(flags, 'x')), y: num(pick(flags, 'y')), zoom: num(pick(flags, 'zoom')) ?? 1 })
    case 'close':
      return call('DELETE', `/widgets/${enc(require1(id, 'canvas close needs <id>'))}`, { agentId: AGENT_ID })
    default:
      throw new OrcError(`canvas: unknown action "${action}" (list|place|rename|move|focus|close)`, 'invalid')
  }
}

async function brain(action, flags, positional = []) {
  const id = pick(flags, 'id') ?? positional[2]
  switch (action) {
    case 'list':
    case undefined:
      return get('/brain')
    case 'search':
      return get('/brain/search', { q: require1(pick(flags, 'query', 'q') ?? positional[2], 'brain search needs <query>') })
    case 'read': {
      const data = await get('/brain')
      const targetId = require1(id, 'brain read needs <id>')
      const note = (data.notes || []).find((n) => n.id === targetId)
      if (!note) throw new OrcError(`no note "${targetId}"`, 'not_found')
      return note
    }
    case 'save':
      return post('/brain', {
        title: require1(pick(flags, 'title') ?? positional[2], 'brain save needs <title>'),
        content: pick(flags, 'content', 'body') ?? positional[3],
        tags: list(pick(flags, 'tags'))
      })
    case 'update':
      return patch(`/brain/${enc(require1(id, 'brain update needs <id>'))}`, {
        title: pick(flags, 'title'),
        content: pick(flags, 'content', 'body'),
        tags: list(pick(flags, 'tags'))
      })
    case 'delete':
      return call('DELETE', `/brain/${enc(require1(id, 'brain delete needs <id>'))}`, { agentId: AGENT_ID })
    default:
      throw new OrcError(`brain: unknown action "${action}" (list|read|search|save|update|delete)`, 'invalid')
  }
}

async function plan(action, flags, positional = []) {
  const id = pick(flags, 'id') ?? positional[2]
  switch (action) {
    case 'list':
    case undefined:
      return get('/planner')
    case 'create':
      return post('/planner', {
        title: require1(pick(flags, 'title') ?? positional[2], 'plan create needs <title>'),
        note: pick(flags, 'note'),
        day: pick(flags, 'day'),
        time: pick(flags, 'time'),
        project: pick(flags, 'project')
      })
    case 'update':
      return patch(`/planner/${enc(require1(id, 'plan update needs <id>'))}`, {
        title: pick(flags, 'title'),
        note: pick(flags, 'note'),
        day: pick(flags, 'day'),
        time: pick(flags, 'time'),
        project: pick(flags, 'project')
      })
    case 'done':
    case 'complete':
      return post(`/planner/${enc(require1(id, `plan ${action} needs <id>`))}/toggle`, { done: true })
    case 'toggle':
      return post(`/planner/${enc(require1(id, 'plan toggle needs <id>'))}/toggle`, { done: flags.done })
    case 'delete':
      return call('DELETE', `/planner/${enc(require1(id, 'plan delete needs <id>'))}`, { agentId: AGENT_ID })
    default:
      throw new OrcError(`plan: unknown action "${action}" (list|create|update|done|toggle|delete)`, 'invalid')
  }
}

async function board(action, flags, positional = []) {
  const id = pick(flags, 'id', 'task') ?? (action === 'claim' || action === 'update' || action === 'done' || action === 'complete' ? positional[2] : undefined)
  switch (action) {
    case 'status':
    case undefined:
      return get('/coordination/status')
    case 'list':
      return get('/coordination/tasks')
    case 'create':
      return post('/coordination/tasks', {
        title: require1(pick(flags, 'title') ?? positional[2], 'board create needs <title>'),
        brief: pick(flags, 'brief'),
        files: list(pick(flags, 'files')),
        state: pick(flags, 'state')
      })
    case 'claim':
      return post(`/coordination/tasks/${enc(require1(id, 'board claim needs <task-id>'))}/claim`, {})
    case 'done':
    case 'complete':
      return patch(`/coordination/tasks/${enc(require1(id, `board ${action} needs <task-id>`))}`, {
        state: 'done'
      })
    case 'update':
      return patch(`/coordination/tasks/${enc(require1(id, 'board update needs <task-id>'))}`, {
        state: require1(pick(flags, 'state') ?? positional[3], 'board update needs <state>')
      })
    case 'become-manager':
      return post('/coordination/manager', {})
    default:
      throw new OrcError(`board: unknown action "${action}" (status|list|create|claim|done|update|become-manager)`, 'invalid')
  }
}

async function terminal(action, flags, positional = []) {
  const id = pick(flags, 'id', 'terminal') ?? (action === 'send' || action === 'read' || action === 'close' ? positional[2] : undefined)
  switch (action) {
    case 'open':
      return post('/widgets/terminal', { title: pick(flags, 'title'), cwd: pick(flags, 'cwd') })
    case 'send':
      return post(`/terminal/${enc(require1(id, 'terminal send needs <terminal-id>'))}/write`, {
        text: require1(pick(flags, 'text', 'command') ?? positional[3], 'terminal send needs text to send'),
        pressEnter: flags.enter !== false
      })
    case 'read':
      return get(`/terminal/${enc(require1(id, 'terminal read needs <terminal-id>'))}/output`, { full: flags.full === true })
    case 'close':
      return call('DELETE', `/widgets/${enc(require1(id, 'terminal close needs <terminal-id>'))}`, { agentId: AGENT_ID })
    default:
      throw new OrcError(`terminal: unknown action "${action}" (open|send|read|close)`, 'invalid')
  }
}

// ----------------------------------------------------------------- utilities

function require1(value, message) {
  if (value === undefined || value === null || value === '' || value === true) throw new OrcError(message, 'invalid')
  return String(value)
}

const enc = (s) => encodeURIComponent(String(s))
const num = (v) => (v === undefined ? undefined : Number(v))

main(process.argv.slice(2)).catch(async (err) => {
  const payload = { ok: false, error: err.message, code: err.code || 'failed' }
  if (asJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else process.stderr.write(`orc: ${err.message}\n`)
  process.exitCode = 1
})
