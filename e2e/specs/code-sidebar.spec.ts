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
