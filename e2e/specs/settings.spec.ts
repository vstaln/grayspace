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

test('settings modal opens and switches tabs', async () => {
  const { page } = ctx

  await page.getByTestId('rail-settings').click()
  const modal = page.getByTestId('settings-modal')
  await expect(modal).toBeVisible()

  await expect(modal.getByTestId('settings-tab-account')).toHaveAttribute('aria-current', 'true')
  await expect(modal.getByText('Display name', { exact: true })).toBeVisible()

  await modal.getByTestId('settings-tab-appearance').click()
  await expect(modal.getByText('Theme', { exact: true })).toBeVisible()

  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(modal).not.toBeVisible()
})
