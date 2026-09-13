import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace } from '../helpers/app'

test('renaming a Code workspace keeps its browser session mounted', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(async () => {
      await window.api.workspace.create(`code-rename-${Date.now()}`)
    })

    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    await page.getByTestId('code-view').getByRole('button', { name: 'Claude Code', exact: true }).click()
    await page.getByTestId('code-launch').click()
    await page.getByTestId('code-view').getByRole('button', { name: 'Open another CLI or browser', exact: true }).click()
    await page.getByRole('dialog', { name: 'Launch Code Session' }).getByRole('button', { name: 'Browser', exact: true }).click()
    await page.getByRole('dialog', { name: 'Launch Code Session' }).getByRole('button', { name: /Launch 1 widget/ }).click()

    const webview = page.getByTestId('code-view').locator('webview')
    await expect(webview).toHaveCount(1)
    await webview.evaluate((element) => element.setAttribute('data-mount-marker', 'kept'))

    const sidebar = page.locator('.rail-shell')
    await sidebar.getByRole('button', { name: /^Rename / }).first().click()
    const renameDialog = page.getByTestId('rename-workspace-dialog')
    await renameDialog.getByTestId('rename-workspace-name').fill(`renamed-${Date.now()}`)
    await renameDialog.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(webview).toHaveAttribute('data-mount-marker', 'kept')
  } finally {
    await closeOrcSpace(ctx)
  }
})
