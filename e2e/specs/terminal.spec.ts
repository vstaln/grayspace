import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  terminalFrame,
  waitForTerminalShell,
  waitForTerminalOutput,
  listTerminals,
  type OrcSpaceFixture
} from '../helpers/app'

/**
 * Journey 2 — the terminal life cycle: rail → widget → shell → typed command →
 * echoed output → close (process dies).
 * Journey 5 — the launch-agent button writes the CLI command into the shell.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

test('a terminal spawns from the rail, runs a command, and closes for real', async () => {
  const { page } = ctx
  const tag = `e2e-${Date.now()}`

  await page.getByTestId('rail-new-terminal').click()
  const id = await waitForTerminalShell(ctx, page)

  // Type into the mounted xterm and let the shell echo it back.
  const frame = terminalFrame(page)
  await frame.getByTestId('terminal-xterm').click()
  await frame.locator('textarea').focus()
  await page.keyboard.type(`echo ${tag}`)
  await page.keyboard.press('Enter')

  // The pty buffer — not the canvas-rendered DOM — proves the keystrokes made
  // it into the real shell and the output came back.
  await waitForTerminalOutput(ctx, id, (output) => output.includes(tag))

  // Closing the widget disposes the shell: the terminal leaves the canvas and
  // disappears from the app's live terminal list.
  await frame.getByTestId('widget-close').click()
  await expect(terminalFrame(page)).toHaveCount(0)
  await expect
    .poll(async () => (await listTerminals(ctx)).some((t) => t.id === id), { timeout: 10_000 })
    .toBe(false)
})

test('the agent-launch button types the CLI command into the shell', async () => {
  const { page } = ctx

  await page.getByTestId('rail-new-terminal').click()
  const id = await waitForTerminalShell(ctx, page)

  const frame = terminalFrame(page)
  await frame.getByTestId('widget-launch-agent').click()

  // The default agent is Antigravity; the contract is that its real CLI command
  // reaches the shell without substituting a different provider.
  await waitForTerminalOutput(ctx, id, (output) => output.includes('agy'))
})