import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, type OrcSpaceFixture } from '../helpers/app'





let ctx: OrcSpaceFixture

async function openToolbarSettings(page: OrcSpaceFixture['page']): Promise<void> {
  await page.getByTestId('toolbar-more').click()
  await page.getByTestId('toolbar-overflow-menu').getByRole('menuitem', { name: 'Settings', exact: true }).click()
}

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

test('settings modal opens and switches tabs', async () => {
  const { page } = ctx

  await openToolbarSettings(page)
  const modal = page.getByTestId('settings-modal')
  await expect(modal).toBeVisible()

  await expect(modal.getByTestId('settings-tab-account')).toHaveAttribute('aria-current', 'true')
  await expect(modal.getByText('Display name', { exact: true })).toBeVisible()

  await modal.getByTestId('settings-tab-appearance').click()
  await expect(modal.getByText('Theme', { exact: true })).toBeVisible()

  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(modal).not.toBeVisible()
})

test('account opens one settings dialog and Escape closes it', async () => {
  const { page } = ctx
  await page.getByRole('tab', { name: 'Code', exact: true }).click()
  await page.getByRole('button', { name: 'Account', exact: true }).click()
  await expect(page.getByTestId('settings-modal')).toHaveCount(1)
  await expect(page.getByTestId('settings-tab-account')).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-modal')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
})

test('favorite names validate, persist, name new terminals and can be cleared', async () => {
  const { page } = ctx
  await openToolbarSettings(page)
  const modal = page.getByTestId('settings-modal')
  const names = modal.getByRole('textbox', { name: 'Favorite terminal names', exact: true })
  const save = modal.getByRole('button', { name: 'Save names', exact: true })
  await names.fill('invalid name!')
  await expect(names).toHaveAttribute('aria-invalid', 'true')
  await expect(save).toBeDisabled()
  await names.fill('Arthur, HENRY\narthur')
  await save.click()
  await expect(modal.getByText('Favorite terminal names saved.', { exact: true })).toBeVisible()
  await page.reload()
  await waitForCanvas(page)
  await openToolbarSettings(page)
  await expect(names).toHaveValue('Arthur\nHENRY')
  await modal.getByRole('button', { name: 'Close settings', exact: true }).click()
  await page.getByRole('button', { name: 'Add terminal', exact: true }).click()
  await expect(page.getByTestId('widget-title')).toHaveText('Arthur')
  await openToolbarSettings(page)
  await names.fill('')
  await save.click()
  await expect(modal.getByText('Favorite terminal names saved.', { exact: true })).toBeVisible()
  await page.reload()
  await waitForCanvas(page)
  await openToolbarSettings(page)
  await expect(names).toHaveValue('')
  await modal.getByRole('button', { name: 'Close settings', exact: true }).click()
})
