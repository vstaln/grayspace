import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  terminalFrame,
  waitForTerminalShell,
  waitForTerminalOutput,
  readTerminalOutput,
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

async function openTerminalFromCanvas(): Promise<void> {
  await ctx.page.getByTestId('canvas').click({ button: 'right', position: { x: 420, y: 260 } })
  await ctx.page.getByTestId('cm-terminal').click()
}

test('a terminal spawns from the canvas menu, runs a command, and closes for real', async () => {
  const { page } = ctx
  const tag = `e2e-${Date.now()}`

  await openTerminalFromCanvas()
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
  // Closing a terminal asks first — the running process is about to be killed.
  await frame.getByTestId('widget-close').click()
  await page.getByTestId('confirm-accept').click()
  await expect(terminalFrame(page)).toHaveCount(0)
  await expect
    .poll(async () => (await listTerminals(ctx)).some((t) => t.id === id), { timeout: 10_000 })
    .toBe(false)
})

test('the agent-launch button types the CLI command into the shell', async () => {
  const { page } = ctx

  await openTerminalFromCanvas()
  const id = await waitForTerminalShell(ctx, page)

  const frame = terminalFrame(page)
  await frame.getByTestId('widget-launch-agent').click()

  // The default agent is Antigravity; the contract is that its real CLI command
  // reaches the shell without substituting a different provider.
  await waitForTerminalOutput(ctx, id, (output) => output.includes('agy'))
})

test('Code paste is delivered only to the focused terminal', async () => {
  const { page } = ctx

  await page.getByRole('tab', { name: 'Code' }).click()
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Launch Code Session' })
  await dialog.getByRole('button', { name: /Launch 4 terminals/ }).click()

  const textareas = page.getByTestId('code-view').locator('.xterm-helper-textarea')
  await expect(textareas).toHaveCount(4, { timeout: 30_000 })
  await expect
    .poll(async () => (await listTerminals(ctx)).filter((terminal) => terminal.id.startsWith('code-')).length, { timeout: 30_000 })
    .toBe(4)

  const codeTerminals = (await listTerminals(ctx)).filter((terminal) => terminal.id.startsWith('code-'))
  const marker = `CODE_PASTE_${Date.now()}`
  await page.evaluate(async (value) => { await navigator.clipboard.writeText(value) }, marker)
  await textareas.nth(2).focus()
  await page.keyboard.press('Control+Shift+V')

  await expect.poll(async () => {
    const outputs = await Promise.all(codeTerminals.map((terminal) => readTerminalOutput(ctx, terminal.id)))
    return outputs.filter((output) => output.includes(marker)).length
  }, { timeout: 10_000 }).toBe(1)
})
