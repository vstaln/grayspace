import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace } from '../helpers/app'

test('Code sidebar toggle stays outside window drag regions and expands the workspace', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    const code = page.getByTestId('code-view')
    const sidebar = page.locator('.rail-shell')
    const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
    await expect(sidebar).toBeVisible()
    await expect(code).toHaveCSS('left', '200px')
    for (const name of ['Collapse sidebar', 'Expand sidebar']) {
      const button = page.getByRole('button', { name, exact: true })
      await expect(button).toBeVisible()
      const overlapsDragRegion = await button.evaluate((element) => {
        const buttonRect = element.getBoundingClientRect()
        return Array.from(document.querySelectorAll('.title-bar-shell *')).some((node) => {
          if (getComputedStyle(node).getPropertyValue('-webkit-app-region') !== 'drag') return false
          const rect = node.getBoundingClientRect()
          return rect.left < buttonRect.right && rect.right > buttonRect.left &&
            rect.top < buttonRect.bottom && rect.bottom > buttonRect.top
        })
      })
      expect(overlapsDragRegion).toBe(false)
      await button.click()
      if (name === 'Collapse sidebar') {
        await expect(sidebar).toHaveCount(0)
        await expect(code).toHaveCSS('left', '0px')
      }
    }
    await expect(sidebar).toBeVisible()
    await expect(code).toHaveCSS('left', '200px')
    await expect(collapse).toBeVisible()
  } finally {
    await closeOrcSpace(ctx)
  }
})

test('Code sidebar shows an existing workspace before the first session', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(async () => {
      const result = await window.api.workspace.create(`code-sidebar-${Date.now()}`)
      if (typeof result !== 'string') throw new Error('failed to create test workspace')
    })

    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    const sidebar = page.locator('.rail-shell')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Workspace 1', exact: true })).toBeVisible()
  } finally {
    await closeOrcSpace(ctx)
  }
})

test('Deleting the last workspace closes its folder', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    const folderName = `delete-last-workspace-${Date.now()}`
    await page.evaluate(async (name) => {
      const result = await window.api.workspace.create(name)
      if (typeof result !== 'string') throw new Error('failed to create test workspace')
    }, folderName)

    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    const sidebar = page.locator('.rail-shell')
    await sidebar.getByRole('button', { name: 'Delete Workspace 1', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Delete workspace' })
    await expect(dialog).toContainText('close this folder')
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(sidebar.getByText(folderName, { exact: true })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.api.workspace.getDir())).toBeNull()
  } finally {
    await closeOrcSpace(ctx)
  }
})
