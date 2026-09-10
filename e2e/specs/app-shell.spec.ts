import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, type OrcSpaceFixture } from '../helpers/app'





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


  for (const id of ['rail-folders', 'rail-settings']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }

  await expect(page.getByTestId('tool-select')).toBeVisible()
  await expect(page.getByTestId('tool-draw')).toBeVisible()
  await expect(page.getByTestId('tool-erase')).toBeVisible()



  await expect.poll(async () => {
    const data = await (await fetch(`http://127.0.0.1:${ctx.controlPort}/health`, {
      headers: { 'x-orcspace-token': ctx.controlToken }
    })).json()
    return data.ok === true && data.server === 'orcspace-control' && data.controlPort === ctx.controlPort
  }, { timeout: 20_000 }).toBe(true)
})

test('ctrl+wheel zooms the world layer, plain wheel pans it', async () => {
  const { page } = ctx
  const world = page.getByTestId('canvas').locator(':scope > div').first()
  const transform = (): Promise<string> => world.evaluate((el) => (el as HTMLElement).style.transform)

  const before = await transform()


  await page.getByTestId('canvas').dispatchEvent('wheel', {
    deltaX: 0,
    deltaY: -240,
    ctrlKey: true,
    clientX: 400,
    clientY: 300
  })
  await expect.poll(transform, { timeout: 3000 }).not.toBe(before)


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

test('keyboard zoom: Ctrl++ zooms in, Ctrl+- zooms out, Ctrl+0 resets', async () => {
  const { page } = ctx
  const world = page.getByTestId('canvas').locator(':scope > div').first()
  const transform = (): Promise<string> => world.evaluate((el) => (el as HTMLElement).style.transform)



  await page.keyboard.press('Control+0')
  await expect.poll(transform, { timeout: 3000 }).toBe('translate3d(0px, 0px, 0px) scale(1)')
  const before = await transform()


  await page.keyboard.press('Control+=')
  await expect.poll(transform, { timeout: 3000 }).not.toBe(before)
  const zoomed = await transform()


  await page.keyboard.press('Control+-')
  await expect.poll(transform, { timeout: 3000 }).not.toBe(zoomed)


  await page.keyboard.press('Control+0')
  await expect.poll(transform, { timeout: 3000 }).toBe(before)
})

test('minimum window size: no horizontal overflow at 800x560', async () => {
  const minCtx = await launchOrcSpace({ viewport: { width: 800, height: 560 } })
  try {
    await waitForCanvas(minCtx.page)


    const canvasWidth = await minCtx.page.getByTestId('canvas').evaluate((el) => el.scrollWidth)
    const viewportWidth = await minCtx.page.evaluate(() => window.innerWidth)
    await expect(canvasWidth).toBeLessThanOrEqual(viewportWidth)
  } finally {
    await closeOrcSpace(minCtx)
  }
})

test('2x HiDPI ink: canvas renders at 2x device scale (skip if no canvas)', async () => {
  const { page } = ctx
  const projectName = test.info().project.name
  if (!projectName.includes('ink')) {
    test.skip()
  }
  await expect(page.getByTestId('canvas')).toBeVisible()

  const backingWidth = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="canvas"]') as HTMLCanvasElement | null
    if (!canvas) return 0
    return canvas.width
  })
  const viewportWidth = await page.evaluate(() => window.innerWidth)

  await expect(backingWidth).toBeGreaterThanOrEqual(viewportWidth * 1.5)
})
