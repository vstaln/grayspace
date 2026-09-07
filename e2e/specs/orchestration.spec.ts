import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  controlGet,
  controlSend,
  readTerminalOutput,
  waitForTerminalOutput,
  type OrcSpaceFixture
} from '../helpers/app'

/**
 * Orchestration, end to end, driven the way an agent actually drives it: by
 * typing `orc ...` into a real pty.
 *
 * This is the only test that can prove the integration works at all. The unit
 * tests cover the store, the commands and the HTTP routes, but every one of
 * them calls the app directly. What none of them touch is the seam an agent
 * meets first — that `orc` is on PATH in a spawned shell, that the shim finds a
 * Node runtime, and that the injected token authenticates. If any of those
 * three is wrong the whole layer is unreachable and every other test still
 * passes.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

/** Quotes an argument for whichever shell this platform spawns. */
const q = (text: string): string => (process.platform === 'win32' ? `"${text}"` : `'${text}'`)

/** Opens a shell and waits for a prompt to be ready for input. */
async function openTerminal(title: string): Promise<string> {
  const created = await controlSend(ctx, 'POST', '/widgets/terminal', { agentId: 'e2e', title })
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)
  const id = created.json?.data?.id ?? created.json?.id
  expect(id, 'terminal id').toBeTruthy()
  // A shell that has not drawn its prompt yet will swallow the first line.
  await waitForTerminalOutput(ctx, id, (out) => out.trim().length > 0, 30_000)
  return id
}

/**
 * True once `sentinel` appears as a line of its own, i.e. as the echo's
 * *output* rather than inside the echoed command line.
 *
 * Matching the bare string is not enough: a pty echoes what was typed, so
 * `echo __X__` puts `__X__` on screen before the command has run at all, and a
 * naive check returns the prompt instead of the result.
 */
function sentinelPrinted(text: string, sentinel: string): boolean {
  // A Windows PTY can emit a bare carriage return while wrapping the echoed
  // command. Treating `\r` as a line boundary makes the sentinel in that
  // command look like the later `echo` result and lets polling return early.
  // Newline is the stable boundary for an actual command result.
  const at = text.lastIndexOf(sentinel)
  if (at < 0) return false
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const before = text.slice(lineStart, at)
  // The command itself is echoed as `... & echo <sentinel>`. A wrapped
  // command can put that suffix after a newline, so reject any candidate
  // whose current line still contains the shell's `echo` keyword.
  if (/\becho\s*$/i.test(before.trim()) || /\becho\s+/i.test(before)) return false
  // The output may be followed by a prompt or cursor-padding controls, so
  // there is no useful trailing-boundary assertion once the second occurrence
  // has been found and the echoed command candidate was rejected above.
  return true
}

/**
 * Types a command into a shell and returns everything it printed afterwards.
 *
 * A sentinel is echoed after the command rather than waiting on the command's
 * own output: shells differ in prompt shape and a CLI that prints nothing on
 * success would otherwise be indistinguishable from one that hung.
 */
async function run(terminalId: string, command: string, timeoutMs = 30_000): Promise<string> {
  const sentinel = `__ORC_DONE_${Math.random().toString(36).slice(2, 8)}__`
  const before = (await readTerminalOutput(ctx, terminalId)).length
  // Send the command and completion marker as two PTY submissions. Putting
  // both on one long Windows `cmd` line lets ConPTY wrap the marker into the
  // echoed input, which is indistinguishable from a real result. A second
  // write is queued by the shell while a long-poll command is running and is
  // executed immediately after it returns.
  await controlSend(ctx, 'POST', `/terminal/${terminalId}/write`, {
    agentId: 'e2e',
    text: command,
    pressEnter: true
  })
  await controlSend(ctx, 'POST', `/terminal/${terminalId}/write`, {
    agentId: 'e2e',
    text: `echo ${sentinel}`,
    pressEnter: true
  })
  const out = await waitForTerminalOutput(
    ctx,
    terminalId,
    (o) => sentinelPrinted(o.slice(before), sentinel),
    timeoutMs
  )
  return out.slice(before)
}

test('the orc CLI is on an agent shell PATH and authenticates itself', async () => {
  const term = await openTerminal('driver')

  // The whole integration in one line: no config, no token pasted, no Node
  // installed — just a command that works because the app spawned this shell.
  const output = await run(term, 'orc status')
  expect(output).not.toContain('not recognized')
  expect(output).not.toContain('command not found')
  expect(output).not.toContain('ORCSPACE_TOKEN is not set')
  expect(output).toMatch(/no open run|run run-\d+/)
})

test('an agent can see, name and type into a sibling agent', async () => {
  const driver = await openTerminal('driver-2')
  const target = await openTerminal('to-be-renamed')

  // 1. It can see the others, and knows which one it is.
  const roster = await run(driver, 'orc workers')
  expect(roster).toContain('to-be-renamed')
  expect(roster).toMatch(/\*\s+driver-2/)

  // 2. It can give one a name that means something.
  const renamed = await run(driver, `orc rename --to to-be-renamed --name backend`)
  expect(renamed).toMatch(/is now "backend"/)
  await expect
    .poll(async () => (await controlGet(ctx, '/widgets')).widgets.find((w: any) => w.id === target)?.title, {
      timeout: 10_000
    })
    .toBe('backend')

  // 3. And then address it by that name — the point of renaming.
  await run(driver, `orc tell backend ${q('echo HELLO_FROM_SIBLING')}`)
  const heard = await waitForTerminalOutput(ctx, target, (o) => o.includes('HELLO_FROM_SIBLING'), 20_000)
  expect(heard).toContain('HELLO_FROM_SIBLING')
})

test('an ambiguous worker name is refused rather than guessed', async () => {
  const driver = await openTerminal('driver-3')
  await openTerminal('twin')
  await openTerminal('twin')

  const output = await run(driver, `orc tell twin ${q('should not arrive')}`)
  expect(output).toMatch(/matches several workers/)
})

test('a full dispatch round-trip: task, worker, worker_done, promotion', async () => {
  const coordinator = await openTerminal('coordinator')

  const run1 = await run(coordinator, `orc run-create --objective ${q('e2e round trip')}`)
  expect(run1).toMatch(/run run-\d+/)

  // Two tasks, the second gated on the first — so the promotion is observable.
  // `--deps` takes a comma list as well as JSON; the list form needs no nested
  // quoting, which cmd.exe mangles.
  const first = await run(coordinator, `orc task-create --spec ${q('step one')} --json`)
  const firstId = /"id":\s*"(otask-\d+)"/.exec(first)?.[1]
  expect(firstId, `task id in: ${first}`).toBeTruthy()

  const second = await run(coordinator, `orc task-create --spec ${q('step two')} --deps ${firstId} --json`)
  expect(second).toContain('"status": "pending"')

  // Dispatch onto an existing shell rather than opening one: this test must not
  // depend on a real `claude` binary being installed on the machine.
  const worker = await openTerminal('worker')
  const dispatched = await run(coordinator, `orc worker-start --task ${firstId} --to worker --json`)
  const dispatchId = /"dispatchId":\s*"(disp-\d+)"/.exec(dispatched)?.[1]
  expect(dispatchId, `dispatch id in: ${dispatched}`).toBeTruthy()

  // The preamble really was typed into the worker's shell — that is what tells
  // it its own ids, and without it a worker cannot report at all.
  const briefed = await waitForTerminalOutput(ctx, worker, (o) => o.includes('ORCSPACE DISPATCH'), 20_000)
  expect(briefed).toContain(firstId!)
  expect(briefed).toContain(dispatchId!)

  // The worker reports, exactly once, the way its preamble told it to.
  const done = await run(
    worker,
    `orc done --outcome succeeded --task-id ${firstId} --dispatch-id ${dispatchId} --body ${q('did it')} --json`
  )
  expect(done).toContain('"status": "completed"')

  // Completing the dependency promoted the task waiting on it.
  const ready = await run(coordinator, 'orc task-list --ready')
  expect(ready).toContain('step two')

  // A second report is refused — the report is once, or it is not a report.
  const again = await run(
    worker,
    `orc done --outcome failed --task-id ${firstId} --dispatch-id ${dispatchId} --json`
  )
  expect(again).toMatch(/already settled/)
})

test('check --wait blocks and returns the moment a worker reports', async () => {
  const coordinator = await openTerminal('coord-wait')
  await run(coordinator, `orc run-create --objective ${q('waiting')}`)
  const task = await run(coordinator, `orc task-create --spec ${q('background job')} --json`)
  const taskId = /"id":\s*"(otask-\d+)"/.exec(task)?.[1]

  const worker = await openTerminal('wait-worker')
  const dispatched = await run(coordinator, `orc worker-start --task ${taskId} --to wait-worker --json`)
  const dispatchId = /"dispatchId":\s*"(disp-\d+)"/.exec(dispatched)?.[1]

  // Park the coordinator. Nothing has been reported yet, so this must hang.
  const sentinel = '__WAIT_RETURNED__'
  const before = (await readTerminalOutput(ctx, coordinator)).length
  await controlSend(ctx, 'POST', `/terminal/${coordinator}/write`, {
    agentId: 'e2e',
    text: 'orc check --wait --types worker_done --timeout-ms 60000',
    pressEnter: true
  })
  await controlSend(ctx, 'POST', `/terminal/${coordinator}/write`, {
    agentId: 'e2e',
    text: `echo ${sentinel}`,
    pressEnter: true
  })

  await new Promise((resolve) => setTimeout(resolve, 3_000))
  const stillWaiting = (await readTerminalOutput(ctx, coordinator)).slice(before)
  expect(
    sentinelPrinted(stillWaiting, sentinel),
    'the wait must not return before anything is reported'
  ).toBe(false)

  await run(worker, `orc done --outcome succeeded --task-id ${taskId} --dispatch-id ${dispatchId} --json`)

  const woken = await waitForTerminalOutput(ctx, coordinator, (o) => sentinelPrinted(o.slice(before), sentinel), 30_000)
  const tail = woken.slice(before)
  expect(tail).toContain('worker_done')
})

test('the orchestration widget shows the fleet on the canvas', async () => {
  const { page } = ctx
  await controlSend(ctx, 'POST', '/widgets', { agentId: 'e2e', kind: 'orchestration', x: 120, y: 120 })
  const widget = page.locator('[data-testid^="widget-orchestration-"]').first()
  await expect(widget).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: 'test-results/orchestration-widget.png' })
})
