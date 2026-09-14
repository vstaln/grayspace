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

test('browser session can expand to the full Code workspace', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(async () => {
      await window.api.workspace.create(`code-browser-expand-${Date.now()}`)
    })

    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    await page.getByTestId('code-view').getByRole('button', { name: 'Claude Code', exact: true }).click()
    await page.getByTestId('code-launch').click()
    await page.getByTestId('code-view').getByRole('button', { name: 'Open another CLI or browser', exact: true }).click()
    await page.getByRole('dialog', { name: 'Launch Code Session' }).getByRole('button', { name: 'Browser', exact: true }).click()
    await page.getByRole('dialog', { name: 'Launch Code Session' }).getByRole('button', { name: /Launch 1 widget/ }).click()

    const codeView = page.getByTestId('code-view')
    const browserSession = codeView.locator('[data-testid="code-session"][data-session-agent="browser"]')
    await expect(browserSession).toHaveCount(1)
    await expect(browserSession.getByRole('button', { name: /Copy terminal name/ })).toHaveCount(0)
    const terminalSession = codeView.locator('[data-testid="code-session"]:not([data-session-agent="browser"])').first()
    const copyName = terminalSession.getByRole('button', { name: /Copy terminal name/ })
    await ctx.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('media:write-clipboard-text')
      ipcMain.handle('media:write-clipboard-text', () => ({ ok: true }))
    })
    await copyName.dblclick()
    await expect(terminalSession.getByRole('button', { name: 'Expand session', exact: true })).toBeVisible()
    const before = await browserSession.boundingBox()
    const workspace = await codeView.boundingBox()
    expect(before).not.toBeNull()
    expect(workspace).not.toBeNull()

    await browserSession.locator('webview').dispatchEvent('enter-html-full-screen')
    await expect(browserSession.getByRole('button', { name: 'Restore session', exact: true })).toBeVisible()
    await expect.poll(async () => browserSession.boundingBox()).not.toEqual(before)
    const after = await browserSession.boundingBox()
    expect(after?.width ?? 0).toBeGreaterThan((before?.width ?? 0) * 1.5)
    expect(after?.width ?? 0).toBeCloseTo(workspace?.width ?? 0, -1)
    expect(after?.height ?? 0).toBeCloseTo((workspace?.height ?? 0) - 40, -1)

    await browserSession.locator('webview').dispatchEvent('leave-html-full-screen')
    await expect(browserSession.getByRole('button', { name: 'Expand session', exact: true })).toBeVisible()
  } finally {
    await closeOrcSpace(ctx)
  }
})

test('closing one of three terminals preserves the remaining scroll positions', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(async () => {
      await window.api.workspace.create(`code-scroll-${Date.now()}`)
    })
    await page.getByRole('tab', { name: 'Code', exact: true }).click()

    const ids = ['code-scroll-1', 'code-scroll-2', 'code-scroll-3']
    await page.evaluate(async (sessionIds) => {
      const workspace = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({
        codeWorkspaceId: workspace.activeId,
        sessions: sessionIds.map((id) => ({
          id,
          agentId: 'custom',
          label: 'Shell',
          command: '',
          title: id,
          status: 'active' as const
        }))
      })
    }, ids)

    const codeView = page.getByTestId('code-view')
    await expect(codeView.getByTestId('terminal-xterm')).toHaveCount(3)
    await expect(codeView.locator('[data-testid="terminal-xterm"] [role="status"]')).toHaveCount(0)
    await page.evaluate(async (sessionIds) => {
      const command = `node -e "for(let i=0;i<300;i++)console.log('line '+i)"\r`
      await Promise.all(sessionIds.map((id) => window.api.terminal.write(id, command)))
    }, ids)
    const viewports = codeView.locator('.xterm-viewport')
    await expect.poll(() => viewports.evaluateAll((items) =>
      items.every((item) => item.scrollHeight > item.clientHeight && item.scrollTop > 0)
    )).toBe(true)

    await codeView.getByTestId('code-session').first().getByRole('button', { name: 'Close session' }).click()
    await expect(codeView.getByTestId('terminal-xterm')).toHaveCount(2)
    await expect.poll(() => viewports.evaluateAll((items) =>
      items.every((item) => item.scrollTop > 0)
    )).toBe(true)
  } finally {
    await closeOrcSpace(ctx)
  }
})
