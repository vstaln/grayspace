import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, type OrcSpaceFixture } from '../helpers/app'

/**
 * Journey 7 — Second Brain: open from the rail, create a note, see it in the
 * list, close the panel.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

test('a new note appears in the brain list', async () => {
  const { page } = ctx

  await page.getByTestId('rail-notes').click()
  const panel = page.getByTestId('brain-panel')
  await expect(panel).toBeVisible()

  await panel.getByTestId('brain-new-note').click()

  // create() makes a default-titled note, selects it, and lands in list view.
  await expect(panel.getByRole('textbox', { name: 'Note title' })).toHaveValue('New Note')

  await panel.getByRole('button', { name: 'Close' }).click()
  await expect(panel).not.toBeVisible()
})