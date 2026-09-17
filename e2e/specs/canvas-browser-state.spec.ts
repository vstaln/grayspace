import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace } from '../helpers/app'

/**
 * The canvas counterpart of the Code-session swap guard.
 *
 * Dragging and maximizing a browser widget are supposed to be style changes:
 * the frame keeps its place in the tree and only its geometry moves. If either
 * ever starts re-parenting the widget instead, the `<webview>` guest is torn
 * down and the page reloads — the same way a swap in the Code view used to
 * restart whatever was playing. The probe is a load that starts after the
 * gesture; the element survives a move, the guest behind it does not.
 */
test('dragging and maximizing a canvas browser widget does not reload its page', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.getByTestId('canvas').click({ button: 'right', position: { x: 120, y: 140 } })
    await page.getByTestId('cm-browser').click()

    const frame = page.locator('[data-testid^="widget-browser-"]')
    await expect(frame).toBeVisible()
    const webview = frame.locator('webview')
    await expect(webview).toHaveCount(1)
    await webview.evaluate((el) => {
      el.setAttribute('data-reload-probe', 'idle')
      el.addEventListener('did-start-loading', () => el.setAttribute('data-reload-probe', 'reloaded'))
    })

    const header = frame.locator('.widget-header-shell')
    const start = await header.boundingBox()
    if (!start) throw new Error('the widget header has no box to drag')
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(start.x + start.width / 2 + 160, start.y + start.height / 2 + 120, { steps: 12 })
    await page.mouse.up()

    await page.getByTestId('widget-maximize').first().click()
    await page.getByTestId('widget-maximize').first().click()

    // A torn-down guest starts loading again within a frame or two.
    await page.waitForTimeout(1_500)
    await expect(webview, 'moving the widget must not reload its page').toHaveAttribute('data-reload-probe', 'idle')
  } finally {
    await closeOrcSpace(ctx)
  }
})
