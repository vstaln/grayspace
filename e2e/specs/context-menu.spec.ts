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
    { x: 320, y: 600 },
    { x: 700, y: 500 },
    { x: 150, y: 500 },
    { x: 900, y: 400 }
  ]
  // Try positions in rotation until one hits bare canvas (not a widget).
  // After a few widgets are on the canvas the original 3 spots are occupied,
  // so a fixed rotation would start clicking inside widgets and the menu
  // never appears (flaky across test ordering).
  for (let attempt = 0; attempt < positions.length; attempt += 1) {
    const position = positions[(contextMenuOpenCount + attempt) % positions.length]
    await ctx.page.getByTestId('canvas').click({ button: 'right', position })
    try {
      await expect(ctx.page.getByRole('menu', { name: 'Context Menu' })).toBeVisible({ timeout: 800 })
      contextMenuOpenCount += attempt + 1
      return
    } catch {
      // Missed — widget was under the cursor, try next slot.
    }
  }
  // Last resort: the original slot (will throw with a clear message if still failing)
  const position = positions[contextMenuOpenCount++ % positions.length]
  await ctx.page.getByTestId('canvas').click({ button: 'right', position })
  await expect(ctx.page.getByRole('menu', { name: 'Context Menu' })).toBeVisible()
}

test('right-click offers every canvas action and places widgets on the canvas', async () => {
  const { page } = ctx

  await openContextMenu()
  // Every widget in the default favourites list (useSettings.ts) — the menu
  // renders exactly those, so this count moves whenever that list does.
  await expect(page.getByRole('menu', { name: 'Context Menu' }).getByRole('menuitem')).toHaveCount(10)

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

  await openContextMenu()
  await page.getByTestId('cm-terminal').click()
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

test('maximizing a widget keeps the state it holds', async () => {
  // Its own instance: the tests above have already covered the canvas with
  // widgets, and this one needs bare canvas to right-click on.
  const own = await launchOrcSpace()
  try {
    const { page } = own
    await waitForCanvas(page)

    // The Links widget is the sharpest probe available: everything it holds is
    // React state backed by localStorage, so if maximizing tears the component
    // down and builds a fresh one, the list comes back empty.
    //
    // It used to. Maximized frames rendered in a different container than
    // in-world ones, and a React key is only unique within a parent — so the
    // toggle unmounted the widget and mounted a new one, and the Links widget's
    // unmount cleanup (which assumed unmount meant "closed") wiped its storage
    // on the way out (WIDGET-maximize).
    await page.getByTestId('canvas').click({ button: 'right', position: { x: 320, y: 260 } })
    await expect(page.getByRole('menu', { name: 'Context Menu' })).toBeVisible()
    await page.getByTestId('cm-links').click()
    const links = page.locator('[data-testid^="widget-links-"]')
    await expect(links).toBeVisible()

    await links.getByLabel('URL').fill('https://example.com/kept')
    await links.getByLabel('Add link').click()
    await expect(links.getByTitle('https://example.com/kept')).toBeVisible()

    await links.getByTestId('widget-maximize').click()
    await expect(links.getByTitle('https://example.com/kept')).toBeVisible()

    await links.getByTestId('widget-maximize').click()
    await expect(links.getByTitle('https://example.com/kept')).toBeVisible()

    // Closing it for real is what clears the saved links.
    await links.getByTestId('widget-close').click()
    await expect(links).toHaveCount(0)

    // A second probe that no amount of persistence could paper over: the
    // Timer keeps everything in memory on purpose ("closing it forgets the
    // timer"), so a running countdown that survives a maximize is proof the
    // component itself was never torn down.
    await page.getByTestId('canvas').click({ button: 'right', position: { x: 700, y: 300 } })
    await expect(page.getByRole('menu', { name: 'Context Menu' })).toBeVisible()
    await page.getByTestId('cm-timer').click()
    const timer = page.locator('[data-testid^="widget-timer-"]')
    await expect(timer).toBeVisible()

    const readout = timer.getByRole('timer')
    await expect(readout).toHaveText('25:00')
    await timer.getByRole('button', { name: 'Start' }).click()
    // Let it get far enough off the preset that a reset would be unmistakable.
    await expect.poll(() => readout.textContent(), { timeout: 5000 }).not.toBe('25:00')
    const running = await readout.textContent()

    await timer.getByTestId('widget-maximize').click()
    await expect(timer.getByRole('button', { name: 'Pause' })).toBeVisible()
    // Still counting down from where it was, not back at the 25:00 preset.
    await expect(readout).not.toHaveText('25:00')
    await expect.poll(() => readout.textContent()).not.toBe(running)
  } finally {
    await closeOrcSpace(own)
  }
})

test('Delete asks before killing a terminal, and can be cancelled', async () => {
  const { page } = ctx

  await openContextMenu()
  await page.getByTestId('cm-terminal').click()
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
