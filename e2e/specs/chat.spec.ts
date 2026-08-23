import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, type OrcSpaceFixture } from '../helpers/app'

/**
 * Journey 8 — the planner widget opens from the context menu and accepts items.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

test('the planner widget opens and accepts new tasks', async () => {
  const { page } = ctx

  await page.getByTestId('canvas').click({ button: 'right', position: { x: 320, y: 260 } })
  await page.getByTestId('cm-planner').click()

  const widget = page.locator('[data-testid^="widget-planner-"]')
  await expect(widget).toBeVisible()

  const input = widget.getByLabel('New planner item')
  const draft = `e2e-plan-${Date.now()}`
  await input.fill(draft)
  await input.press('Enter')
  await expect(widget.getByText(draft)).toBeVisible()
})