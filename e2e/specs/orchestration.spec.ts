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













let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})


const q = (text: string): string => (process.platform === 'win32' ? `"${text}"` : `'${text}'`)


async function openTerminal(title: string): Promise<string> {
  const created = await controlSend(ctx, 'POST', '/widgets/terminal', { agentId: 'e2e', title })
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)
  const id = created.json?.data?.id ?? created.json?.id
  expect(id, 'terminal id').toBeTruthy()

  await waitForTerminalOutput(ctx, id, (out) => out.trim().length > 0, 30_000)
  return id
}









function sentinelPrinted(text: string, sentinel: string): boolean {




  const at = text.lastIndexOf(sentinel)
  if (at < 0) return false
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const before = text.slice(lineStart, at)



  if (/\becho\s*$/i.test(before.trim()) || /\becho\s+/i.test(before)) return false



  return true
}








async function run(terminalId: string, command: string, timeoutMs = 30_000): Promise<string> {
  const sentinel = `__ORC_DONE_${Math.random().toString(36).slice(2, 8)}__`
  const before = (await readTerminalOutput(ctx, terminalId)).length





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



  const output = await run(term, 'orc status')
  expect(output).not.toContain('not recognized')
  expect(output).not.toContain('command not found')
  expect(output).not.toContain('ORCSPACE_TOKEN is not set')
  expect(output).toMatch(/no open run|run run-\d+/)
})

test('an agent can see, name and type into a sibling agent', async () => {
  const driver = await openTerminal('driver-2')
  const target = await openTerminal('to-be-renamed')


  const roster = await run(driver, 'orc workers')
  expect(roster).toContain('to-be-renamed')
  expect(roster).toMatch(/\*\s+driver-2/)


  const renamed = await run(driver, `orc rename --to to-be-renamed --name backend`)
  expect(renamed).toMatch(/is now "backend"/)
  await expect
    .poll(async () => (await controlGet(ctx, '/widgets')).widgets.find((w: any) => w.id === target)?.title, {
      timeout: 10_000
    })
    .toBe('backend')


  await run(driver, `orc tell backend ${q('echo HELLO_FROM_SIBLING')}`)
  const heard = await waitForTerminalOutput(ctx, target, (o) => o.includes('HELLO_FROM_SIBLING'), 20_000)
  expect(heard).toContain('HELLO_FROM_SIBLING')
})

test('an ambiguous worker name is refused rather than guessed', async () => {
  const driver = await openTerminal('driver-3')
  await openTerminal('twin-one')
  await openTerminal('twin-two')

  const output = await run(driver, `orc tell twin ${q('should not arrive')}`)
  expect(output).toMatch(/matches several workers/)
})

test('a full dispatch round-trip: task, worker, worker_done, promotion', async () => {
  const coordinator = await openTerminal('coordinator')

  const run1 = await run(coordinator, `orc run-create --objective ${q('e2e round trip')}`)
  expect(run1).toMatch(/run run-\d+/)




  const first = await run(coordinator, `orc task-create --spec ${q('step one')} --json`)
  const firstId = /"id":\s*"(otask-\d+)"/.exec(first)?.[1]
  expect(firstId, `task id in: ${first}`).toBeTruthy()

  const second = await run(coordinator, `orc task-create --spec ${q('step two')} --deps ${firstId} --json`)
  expect(second).toContain('"status": "pending"')



  const worker = await openTerminal('worker')
  const dispatched = await run(coordinator, `orc worker-start --task ${firstId} --to worker --json`)
  const dispatchId = /"dispatchId":\s*"(disp-\d+)"/.exec(dispatched)?.[1]
  expect(dispatchId, `dispatch id in: ${dispatched}`).toBeTruthy()



  const briefed = await waitForTerminalOutput(ctx, worker, (o) => o.includes('ORCSPACE DISPATCH'), 20_000)
  expect(briefed).toContain(firstId!)
  expect(briefed).toContain(dispatchId!)


  const done = await run(
    worker,
    `orc done --outcome succeeded --task-id ${firstId} --dispatch-id ${dispatchId} --body ${q('did it')} --json`
  )
  expect(done).toContain('"status": "completed"')


  const ready = await run(coordinator, 'orc task-list --ready')
  expect(ready).toContain('step two')


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
