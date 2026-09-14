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






let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

async function openContextMenu(): Promise<void> {
  const canvas = ctx.page.getByTestId('canvas')
  const position = await canvas.evaluate((el) => {
    const canvasRect = el.getBoundingClientRect()
    const widgets = Array.from(el.querySelectorAll<HTMLElement>('.widget')).map((widget) => widget.getBoundingClientRect())
    const candidates: Array<{ x: number; y: number }> = []
    for (let y = 80; y < canvasRect.height; y += 80) {
      for (let x = 80; x < canvasRect.width; x += 120) candidates.push({ x, y })
    }
    return candidates.find(({ x, y }) => {
      const px = canvasRect.left + x
      const py = canvasRect.top + y
      return !widgets.some((rect) => px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom)
    }) ?? { x: 80, y: 80 }
  })
  await canvas.click({ button: 'right', position })
  await expect(ctx.page.getByRole('menu', { name: 'Context Menu' })).toBeVisible()
}

test('right-click offers every canvas action and places widgets on the canvas', async () => {
  const { page } = ctx

  await openContextMenu()


  await expect(page.getByRole('menu', { name: 'Context Menu' }).getByRole('menuitem')).toHaveCount(10)


  await page.getByTestId('cm-timer').click()
  await expect(page.locator('[data-testid^="widget-timer-"]')).toBeVisible()


  await openContextMenu()
  await page.getByTestId('cm-planner').click()
  await expect(page.locator('[data-testid^="widget-planner-"]')).toBeVisible()


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
  const terminal = frame.getByTestId('terminal-xterm')
  await terminal.evaluate((element) => element.setAttribute('data-mount-marker', 'kept'))


  await frame.getByTestId('widget-maximize').click()
  await expect
    .poll(() => frame.evaluate((el) => (el as HTMLElement).offsetHeight))
    .toBeGreaterThan(fullHeight)
  await expect(terminal).toHaveAttribute('data-mount-marker', 'kept')
  await frame.getByTestId('widget-maximize').click()
  await expect.poll(() => frame.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeCloseTo(fullHeight, 0)


  const newTitle = `renamed-${Date.now()}`
  await frame.getByTestId('widget-title').dblclick()
  await expect(frame.getByTestId('widget-title-input')).toBeFocused()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(newTitle)
  await page.keyboard.press('Enter')
  await expect(frame.getByTestId('widget-title')).toHaveText(newTitle)

  void id
})

test('maximizing a browser keeps its webview mounted', async () => {
  const { page } = ctx

  await openContextMenu()
  await page.getByTestId('cm-browser').click()
  const frame = page.locator('[data-testid^="widget-browser-"]').last()
  const webview = frame.locator('webview')
  await expect(webview).toHaveCount(1)
  await webview.evaluate((element) => element.setAttribute('data-mount-marker', 'kept'))
  const before = await frame.boundingBox()
  expect(before).not.toBeNull()

  await frame.getByTestId('widget-maximize').click()
  await expect.poll(async () => (await frame.boundingBox())?.width ?? 0).toBeGreaterThan((before?.width ?? 0) * 1.5)
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan((before?.height ?? 0) * 1.5)
  const after = await frame.boundingBox()
  expect(after?.width ?? 0).toBeGreaterThan((before?.width ?? 0) * 1.5)
  expect(after?.height ?? 0).toBeGreaterThan((before?.height ?? 0) * 1.5)
  await expect(webview).toHaveAttribute('data-mount-marker', 'kept')

  await frame.getByTestId('widget-maximize').click()
  await expect(webview).toHaveAttribute('data-mount-marker', 'kept')
})

test('maximizing a widget keeps the state it holds', async () => {


  const own = await launchOrcSpace()
  try {
    const { page } = own
    await waitForCanvas(page)










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


    await links.getByTestId('widget-close').click()
    await expect(links).toHaveCount(0)





    await page.getByTestId('canvas').click({ button: 'right', position: { x: 700, y: 300 } })
    await expect(page.getByRole('menu', { name: 'Context Menu' })).toBeVisible()
    await page.getByTestId('cm-timer').click()
    const timer = page.locator('[data-testid^="widget-timer-"]')
    await expect(timer).toBeVisible()

    const readout = timer.getByRole('timer')
    await expect(readout).toHaveText('25:00')
    await timer.getByRole('button', { name: 'Start' }).click()

    await expect.poll(() => readout.textContent(), { timeout: 5000 }).not.toBe('25:00')
    const running = await readout.textContent()

    await timer.getByTestId('widget-maximize').click()
    await expect(timer.getByRole('button', { name: 'Pause' })).toBeVisible()

    await expect(readout).not.toHaveText('25:00')
    await expect.poll(() => readout.textContent(), { timeout: 5000, intervals: [250, 500] }).not.toBe(running)
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


  await frame.focus()
  await page.keyboard.press('Delete')
  const dialog = page.getByRole('alertdialog', { name: 'Close Terminal' })
  await expect(dialog).toBeVisible()


  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(terminalFrame(page)).toBeVisible()


  await frame.focus()
  await page.keyboard.press('Delete')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect
    .poll(async () => (await listTerminals(ctx)).some((terminal) => terminal.id === id), { timeout: 10_000 })
    .toBe(false)
})
