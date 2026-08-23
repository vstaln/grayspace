import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  terminalFrame,
  waitForTerminalShell,
  listTerminals,
  type OrcSpaceFixture
} from '../helpers/app'

/**
 * Journey 3 — the canvas context menu drops every kind of widget.
  * Journey 4 — widget chrome: maximize/restore and rename, plus the context
 * the Delete-key confirm path for terminals.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

let contextMenuOpenCount = 0

async function openContextMenu(): Promise<void> {
  const positions = [
    { x: 320, y: 260 },
    { x: 850, y: 220 },
    // Below the timer (300x220 from the first open) and clear of the planner
    // (420x520 dropped at the second open) — right-clicks must hit bare canvas.
    { x: 320, y: 600 }
  ]
  const position = positions[contextMenuOpenCount++ % positions.length]
  await ctx.page.getByTestId('canvas').click({ button: 'right', position })
  await expect(ctx.page.getByRole('menu', { name: 'Context Menu' })).toBeVisible()
}

test('right-click offers every canvas action and places widgets on the canvas', async () => {
  const { page } = ctx

  await openContextMenu()
  await expect(page.getByRole('menu', { name: 'Context Menu' }).getByRole('menuitem')).toHaveCount(7)

  // A stateless widget lands instantly.
  await page.getByTestId('cm-timer').click()
  await expect(page.locator('[data-testid^="widget-timer-"]')).toBeVisible()

  // The planner widget, too.
  await openContextMenu()
  await page.getByTestId('cm-planner').click()
  await expect(page.locator('[data-testid^="widget-planner-"]')).toBeVisible()

  // And a terminal through the menu path (equivalent to the rail button).
  await openContextMenu()
  await page.getByTestId('cm-terminal').click()
  await expect(terminalFrame(page)).toBeVisible()
})

test('widgets maximize and rename', async () => {
  const { page } = ctx

  await page.getByTestId('rail-new-terminal').click()
  const id = await waitForTerminalShell(ctx, page)
  const frame = terminalFrame(page)
  const fullHeight = await frame.evaluate((el) => (el as HTMLElement).offsetHeight)

  // Maximize floats the widget over the whole canvas area.
  await frame.getByTestId('widget-maximize').click()
  await expect
    .poll(() => frame.evaluate((el) => (el as HTMLElement).offsetHeight))
    .toBeGreaterThan(fullHeight)
  await frame.getByTestId('widget-maximize').click()
  await expect.poll(() => frame.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeCloseTo(fullHeight, 0)

  // Double-click the title to rename; Enter commits.
  const newTitle = `renamed-${Date.now()}`
  await frame.getByTestId('widget-title').dblclick()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(newTitle)
  await page.keyboard.press('Enter')
  await expect(frame.getByTestId('widget-title')).toHaveText(newTitle)

  void id
})

test('Delete asks before killing a terminal, and can be cancelled', async () => {
  const { page } = ctx

  await page.getByTestId('rail-new-terminal').click()
  const id = await waitForTerminalShell(ctx, page)
  const frame = terminalFrame(page)

  // Focus the frame itself, then Delete → the in-app confirm appears.
  await frame.focus()
  await page.keyboard.press('Delete')
  const dialog = page.getByRole('alertdialog', { name: 'Close Terminal' })
  await expect(dialog).toBeVisible()

  // Cancel keeps the shell running and the widget on the canvas.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(terminalFrame(page)).toBeVisible()

  // Confirming closes it.
  await frame.focus()
  await page.keyboard.press('Delete')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect
    .poll(async () => (await listTerminals(ctx)).some((terminal) => terminal.id === id), { timeout: 10_000 })
    .toBe(false)
})