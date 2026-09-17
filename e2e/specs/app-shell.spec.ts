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


  await expect(page.getByTestId('toolbar-more')).toBeVisible()
  await page.getByTestId('toolbar-more').click()
  const overflow = page.getByTestId('toolbar-overflow-menu')
  await expect(overflow).toBeVisible()
  const changeDir = overflow.getByRole('menuitem', { name: 'Change directory', exact: true })
  await expect(overflow.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible()
  await expect(changeDir).toBeVisible()
  await expect(changeDir).toBeFocused()
  await expect(overflow.getByTestId('command-mode')).toBeVisible()
  await expect(overflow.getByRole('combobox', { name: 'Target terminal', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(overflow).toHaveCount(0)
  await expect(page.getByTestId('toolbar-more')).toBeFocused()

  await expect(page.getByTestId('tool-select')).toBeVisible()
  await expect(page.getByTestId('tool-draw')).toBeVisible()
  await expect(page.getByTestId('tool-erase')).toBeVisible()
  await expect(page.locator('.title-bar-view-switch [role="tab"] svg')).toHaveCount(0)



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

test('keyboard zoom: Ctrl++ zooms in, Ctrl+- zooms out, 0 resets zoom and Home resets the view', async () => {
  const { page } = ctx
  await page.getByTestId('canvas').focus()
  const world = page.getByTestId('canvas').locator(':scope > div').first()
  const transform = (): Promise<string> => world.evaluate((el) => (el as HTMLElement).style.transform)

  await page.getByTestId('canvas').dispatchEvent('wheel', {
    deltaX: 0,
    deltaY: 120,
    ctrlKey: false,
    clientX: 400,
    clientY: 300
  })
  await expect.poll(transform, { timeout: 3000 }).not.toBe('translate3d(0px, 0px, 0px) scale(1)')


  await page.keyboard.press('Control+0')
  await expect.poll(transform, { timeout: 3000 }).toMatch(/scale\(1\)$/)
  await expect.poll(transform, { timeout: 3000 }).not.toBe('translate3d(0px, 0px, 0px) scale(1)')
  const before = await transform()


  await page.keyboard.press('Control+=')
  await expect.poll(transform, { timeout: 3000 }).not.toBe(before)
  await page.keyboard.press('Control+0')
  await expect.poll(transform, { timeout: 3000 }).toMatch(/scale\(1\)$/)
  await expect.poll(transform, { timeout: 3000 }).not.toBe(before)

  const resetAfterZoom = await transform()
  await page.keyboard.press('Control+-')
  await expect.poll(transform, { timeout: 3000 }).not.toBe(resetAfterZoom)
  await page.keyboard.press('Control+0')
  await expect.poll(transform, { timeout: 3000 }).toMatch(/scale\(1\)$/)
  await expect.poll(transform, { timeout: 3000 }).not.toBe(resetAfterZoom)
  await page.keyboard.press('Home')
  await expect.poll(transform, { timeout: 3000 }).toBe('translate3d(0px, 0px, 0px) scale(1)')
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

test('Code navigation keeps the sidebar expanded and tabs outside drag regions', async () => {
  const { page } = ctx
  await expect(page.getByRole('button', { name: /sidebar/i })).toHaveCount(0)

  // Native Electron hit testing can consume clicks even when Playwright can click the tab.
  const expectTabsOutsideDragRegions = async (): Promise<void> => {
    const overlaps = await page.locator('.title-bar-shell').evaluate((shell) => {
      const dragRects = Array.from(shell.querySelectorAll('*'))
        .filter((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag')
        .map((el) => el.getBoundingClientRect())
      return Array.from(shell.querySelectorAll('[role="tab"]'))
        .some((tab) => {
          const rect = tab.getBoundingClientRect()
          return dragRects.some((drag) => drag.width > 0 && drag.height > 0 &&
            drag.left < rect.right && drag.right > rect.left &&
            drag.top < rect.bottom && drag.bottom > rect.top)
        })
    })
    expect(overlaps).toBe(false)
  }
  await expectTabsOutsideDragRegions()
  await page.getByRole('tab', { name: 'Code', exact: true }).click()
  // The Code view owns a sidebar toggle (see code-sidebar.spec.ts, which
  // covers its behaviour). This spec only cares that it starts in the
  // expanded state and that adding it did not push the tabs under a drag
  // region; asserting the button away entirely contradicted the toggle the
  // title bar actually renders here.
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible()
  await expectTabsOutsideDragRegions()
  await expect(page.locator('.rail-shell')).toBeVisible()
  await expect(page.locator('.rail-shell')).toHaveCSS('width', '200px')
  await expect(page.getByTestId('code-view')).toHaveCSS('left', '200px')
  await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
  await expect(page.getByRole('button', { name: /sidebar/i })).toHaveCount(0)
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
