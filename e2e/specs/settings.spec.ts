import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, type OrcSpaceFixture } from '../helpers/app'

/**
 * Journey 9 — Settings: open from the rail, switch to Integrations, and verify
 * the control settings for this instance.
 */
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

  // Appearance tab by default
  await expect(modal.getByTestId('settings-tab-appearance')).toBeVisible()
  await expect(modal.getByText('Theme', { exact: true })).toBeVisible()

  // Switch to Account (the API Keys tab was removed together with the
  // OpenRouter/Tavily integrations)
  await modal.getByTestId('settings-tab-account').click()
  await expect(modal.getByText('Display name', { exact: true })).toBeVisible()

  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(modal).not.toBeVisible()
})