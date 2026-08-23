import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, type OrcSpaceFixture } from '../helpers/app'

/**
 * Journey 1 — the app boots from the built output into a working canvas.
 * Journey 10 — canvas pan/zoom gestures move the world layer.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

test('the shell starts and renders the canvas chrome', async () => {
  const { page } = ctx

  // Rail: every entry the user needs day to day.
  for (const id of ['rail-new-terminal', 'rail-board', 'rail-notes', 'rail-folders', 'rail-settings']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
  // Floating toolbar with the tool switcher.
  await expect(page.getByTestId('tool-select')).toBeVisible()
  await expect(page.getByTestId('tool-draw')).toBeVisible()
  await expect(page.getByTestId('tool-erase')).toBeVisible()

  // The app is genuinely alive: its loopback control API answers and reports
  // the bundled MCP server on the port this instance was told to use.
  await expect.poll(async () => {
    const data = await (await fetch(`http://127.0.0.1:${ctx.controlPort}/health`, {
      headers: { 'x-orcspace-token': ctx.controlToken }
    })).json()
    return data.mcpRunning === true && data.mcpPort === ctx.mcpPort
  }, { timeout: 20_000 }).toBe(true)
})

test('ctrl+wheel zooms the world layer, plain wheel pans it', async () => {
  const { page } = ctx
  const world = page.getByTestId('canvas').locator(':scope > div').first()
  const transform = (): Promise<string> => world.evaluate((el) => (el as HTMLElement).style.transform)

  const before = await transform()

  // Ctrl+wheel zooms toward the cursor (the translate terms change too).
  await page.getByTestId('canvas').dispatchEvent('wheel', {
    deltaX: 0,
    deltaY: -240,
    ctrlKey: true,
    clientX: 400,
    clientY: 300
  })
  await expect.poll(transform, { timeout: 3000 }).not.toBe(before)

  // A plain wheel pans — the transform changes again.
  const zoomed = await transform()
  await page.getByTestId('canvas').dispatchEvent('wheel', {
    deltaX: 0,
    deltaY: 240,
    ctrlKey: false,
    clientX: 400,
    clientY: 300
  })
  await expect.poll(transform, { timeout: 3000 }).not.toBe(zoomed)
})