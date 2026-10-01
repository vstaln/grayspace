import { createServer } from 'node:http'
import { test, expect } from '@playwright/test'
import { launchOrcSpace, closeOrcSpace, waitForCanvas } from '../helpers/app'

test('a new-window link in Code navigates its own browser instead of opening Canvas', async () => {
  const ctx = await launchOrcSpace()
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(request.url === '/next'
      ? '<title>Destination</title><h1>Destination</h1>'
      : '<title>Start</title><a href="/next" target="_blank">Open link</a>')
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no port')
    const url = `http://127.0.0.1:${address.port}`
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(() => window.api.workspace.create(`code-browser-links-${Date.now()}`))
    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    await page.evaluate(async () => {
      const workspace = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({
        codeWorkspaceId: workspace.activeId,
        sessions: [{ id: 'link-browser', agentId: 'browser', label: 'Browser', command: 'browser', status: 'active' as const }]
      })
    })
    const browser = page.getByTestId('code-view').locator('[data-testid="code-session"][data-session-agent="browser"] webview')
    await expect(browser).toHaveCount(1)
    await browser.evaluate((view: any, target) => view.loadURL(target), url)
    await expect.poll(() => browser.evaluate((view: any) => view.getURL())).toBe(`${url}/`)
    const guestId = await browser.evaluate((view: any) => view.getWebContentsId())

    await browser.evaluate((view: any) => view.executeJavaScript("document.querySelector('a').click()", true))

    await expect.poll(() => browser.evaluate((view: any) => view.getURL())).toBe(`${url}/next`)
    expect(await browser.evaluate((view: any) => view.getWebContentsId())).toBe(guestId)
    await expect(page.locator('[data-testid^="widget-browser-"]')).toHaveCount(0)
    await expect(browser).toHaveCount(1)
  } finally {
    await closeOrcSpace(ctx)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
