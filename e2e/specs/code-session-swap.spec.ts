import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace } from '../helpers/app'

/**
 * Swapping two Code sessions must rearrange the layout, not the DOM.
 *
 * A `<webview>` does not survive being moved between parents or re-inserted
 * among its siblings: the guest process is destroyed and the page reloads from
 * the top, which is how a video that had been playing for a minute came back at
 * zero. The probe is a `did-start-loading` listener on the element: the element
 * itself survives a DOM move, so a load starting after the swap means the guest
 * behind it was torn down and rebuilt. A missing probe attribute would mean the
 * element was replaced outright, which is the same bug one step worse.
 */
test('swapping Code sessions rearranges the grid without reloading the browser guest', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(() => window.api.workspace.create(`code-swap-${Date.now()}`))
    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    await page.evaluate(async () => {
      const workspace = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({
        codeWorkspaceId: workspace.activeId,
        sessions: [
          { id: 'swap-browser', agentId: 'browser', label: 'Browser', command: 'browser', status: 'active' as const },
          { id: 'swap-shell', agentId: 'custom', label: 'Shell', command: '', status: 'active' as const }
        ]
      })
    })

    const codeView = page.getByTestId('code-view')
    const browserCard = codeView.locator('[data-testid="code-session"][data-session-agent="browser"]')
    await expect(browserCard).toHaveCount(1)
    const webview = browserCard.locator('webview')
    await expect(webview).toHaveCount(1)

    await webview.evaluate((el) => {
      el.setAttribute('data-reload-probe', 'idle')
      el.addEventListener('did-start-loading', () => el.setAttribute('data-reload-probe', 'reloaded'))
    })
    await expect(webview).toHaveAttribute('data-reload-probe', 'idle')

    const layoutBefore = await browserCard.evaluate((el) => getComputedStyle(el).order)
    const domOrderBefore = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="code-session"]'), (el) => el.getAttribute('data-session-agent'))
    )

    // The card's own drop handler, driven with the DataTransfer payload the
    // header sets on drag — Playwright cannot run a real HTML5 drag here.
    await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('[data-testid="code-session"]')).find(
        (el) => el.getAttribute('data-session-agent') !== 'browser'
      )
      if (!target) throw new Error('the second session card is missing')
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('text/session-id', 'swap-browser')
      for (const type of ['dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }))
      }
    })

    await expect
      .poll(() => browserCard.evaluate((el) => getComputedStyle(el).order), { message: 'the swap must move the card to the other slot' })
      .not.toBe(layoutBefore)

    const domOrderAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="code-session"]'), (el) => el.getAttribute('data-session-agent'))
    )
    expect(domOrderAfter, 'the cards must keep their DOM positions').toEqual(domOrderBefore)

    // A torn-down guest starts loading again within a frame or two; give it
    // room to show itself rather than reading the attribute the same tick.
    await page.waitForTimeout(1_500)
    await expect(webview, 'the swap must not reload the browser guest').toHaveAttribute('data-reload-probe', 'idle')
  } finally {
    await closeOrcSpace(ctx)
  }
})
