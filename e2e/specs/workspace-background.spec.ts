import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace } from '../helpers/app'

test('a shell that exits in the background remains finished when returning', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(() => window.api.workspace.create(`background-exit-${Date.now()}`))
    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    const first = await page.evaluate(async () => {
      const state = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({ codeWorkspaceId: state.activeId, sessions: [{
        id: 'exiting-shell', agentId: 'custom', label: 'Shell', command: '', status: 'active'
      }] })
      return state.activeId
    })
    const terminal = page.getByTestId('terminal-xterm')
    await expect(terminal).toHaveCount(1)
    await expect(terminal.locator('[role="status"]')).toHaveCount(0)
    await expect(terminal).toContainText('>')
    await terminal.locator('textarea').focus()
    await expect(terminal.locator('.xterm-cursor-blink')).toHaveCount(1)
    await expect.poll(() => terminal.locator('.xterm-cursor-blink').evaluate((cursor) =>
      getComputedStyle(cursor).animationName
    )).not.toBe('none')
    await terminal.evaluate((element) => element.setAttribute('data-retained', 'yes'))
    const exitResult = await page.evaluate(async () => {
      window.api.terminal.onExit('exiting-shell', (code) => {
        document.documentElement.dataset.backgroundExit = String(code)
      })
      window.dispatchEvent(new Event('orcspace:before-code-workspace-switch'))
      await window.api.workspace.createCodeWorkspace('Second')
      return window.api.terminal.write('exiting-shell', 'exit\r')
    })
    expect(exitResult).toMatchObject({ ok: true })
    await expect(terminal).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-background-exit', /\d+/)
    await expect(page.getByTitle('Process exited', { exact: true })).toHaveCount(1)
    await page.evaluate((id) => window.api.workspace.selectCodeWorkspace(id), first)
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-retained', 'yes')
    await expect(page.getByTitle('Process exited', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () =>
      (await window.api.code.load()).sessions.find((session) => session.id === 'exiting-shell')?.status
    )).toBe('finished')
    // Deleting the active slot must also remove the mounted emulator.
    await page.evaluate(async (id) => {
      window.dispatchEvent(new Event('orcspace:before-code-workspace-switch'))
      await window.api.workspace.deleteCodeWorkspace(id)
    }, first)
    await expect(terminal).toHaveCount(0)
  } finally {
    await closeOrcSpace(ctx)
  }
})

test('background workspace retains its emulator and answers terminal queries', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(() => window.api.workspace.create(`background-${Date.now()}`))
    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    const firstId = await page.evaluate(async () => {
      const state = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({ codeWorkspaceId: state.activeId, sessions: [{
        id: 'background-shell', agentId: 'custom', label: 'Shell', command: '', status: 'active'
      }, {
        id: 'background-browser', agentId: 'browser', label: 'Browser', command: '', status: 'active'
      }] })
      return state.activeId
    })
    const terminal = page.getByTestId('terminal-xterm')
    await expect(terminal).toHaveCount(1)
    await expect(terminal.locator('[role="status"]')).toHaveCount(0)
    await terminal.evaluate((element) => element.setAttribute('data-retained', 'yes'))
    const browser = page.getByTestId('code-view').locator('webview')
    await expect(browser).toHaveCount(1)
    await browser.evaluate((element) => element.setAttribute('data-retained', 'yes'))
    const second = await page.evaluate(async () => {
      window.dispatchEvent(new Event('orcspace:before-code-workspace-switch'))
      return window.api.workspace.createCodeWorkspace('Second')
    })
    if ('error' in second) throw new Error(second.error)
    await expect(terminal).toBeHidden()
    await expect(terminal).toHaveAttribute('data-retained', 'yes')
    await ctx.app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('terminal:write')
      ipcMain.handle('terminal:write', (_event, id, data) => {
        if (id === 'background-shell' && /^\x1b\[\d+;\d+R$/.test(data)) {
          ;(globalThis as typeof globalThis & { backgroundQueryAnswered?: boolean }).backgroundQueryAnswered = true
          BrowserWindow.getAllWindows()[0].webContents.send('terminal:onData', id, '\r\nBACKGROUND_QUERY_OK\r\n')
        }
        return { ok: true }
      })
      BrowserWindow.getAllWindows()[0].webContents.send('terminal:onData', 'background-shell', '\x1b[6n')
    })
    // Wait for the reply while the workspace is still hidden.
    await expect.poll(() => ctx.app.evaluate(() =>
      (globalThis as typeof globalThis & { backgroundQueryAnswered?: boolean }).backgroundQueryAnswered
    )).toBe(true)
    await page.evaluate(async (id) => {
      window.dispatchEvent(new Event('orcspace:before-code-workspace-switch'))
      await window.api.workspace.selectCodeWorkspace(id)
    }, firstId)
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-retained', 'yes')
    await expect(terminal).toContainText('BACKGROUND_QUERY_OK')
    await expect(browser).toHaveAttribute('data-retained', 'yes')
    const discarded = await page.evaluate(async () => {
      const state = await window.api.workspace.codeWorkspaces()
      return window.api.code.save({ codeWorkspaceId: state.activeId, workspaceScope: 'another-folder\u0000' + state.activeId, sessions: [] })
    })
    expect(discarded).toMatchObject({ discarded: true })
    await ctx.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('code:onChange', {
        workspaceScope: 'another-folder\u0000other', schemaVersion: 1, sessions: [],
        featuredId: null, maximizedId: null, version: 500
      })
    })
    for (let i = 0; i < 3; i++) {
      await page.evaluate(async ({ firstId, secondId }) => {
        window.dispatchEvent(new Event('orcspace:before-code-workspace-switch'))
        await window.api.workspace.selectCodeWorkspace(secondId)
        await window.api.workspace.selectCodeWorkspace(firstId)
      }, { firstId, secondId: second.id })
      await expect(terminal).toBeVisible()
      await expect(terminal).toHaveAttribute('data-retained', 'yes')
      await expect(browser).toHaveAttribute('data-retained', 'yes')
    }
    await page.evaluate(async ({ firstId, secondId }) => {
      window.dispatchEvent(new Event('orcspace:before-code-workspace-switch'))
      await window.api.workspace.selectCodeWorkspace(secondId)
      await window.api.workspace.deleteCodeWorkspace(firstId)
    }, { firstId, secondId: second.id })
    await expect(terminal).toHaveCount(0)
    await expect(browser).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () =>
      (await window.api.terminal.list()).some((item) => item.id === 'background-shell')
    )).toBe(false)
  } finally {
    await closeOrcSpace(ctx)
  }
})
