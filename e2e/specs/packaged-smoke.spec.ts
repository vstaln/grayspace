import { test, expect } from '@playwright/test'
import { launchPackaged } from '../helpers/packaged'
import { waitForCanvas } from '../helpers/app'

// Packaging is the one configuration where the ConPTY host can go missing: the
// bundled conpty.dll lives inside app.asar.unpacked, and the shell only reaches
// a prompt if the packaged app resolves and loads it from there. Running the
// real installer output is the only way that path is exercised at all.
test('the packaged app opens a terminal that reaches its shell prompt', async () => {
  test.setTimeout(180_000)
  const app = await launchPackaged()
  try {
    const { page } = app
    await waitForCanvas(page)
    await page.evaluate((name) => window.api.workspace.create(name), `packaged-smoke-${Date.now()}`)
    await page.getByRole('tab', { name: 'Code', exact: true }).click()

    const startedAt = Date.now()
    await page.evaluate(async () => {
      const workspace = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({
        codeWorkspaceId: workspace.activeId,
        sessions: [{ id: 'packaged-shell', agentId: 'custom', label: 'Shell', command: '', status: 'active' as const }]
      })
    })

    const terminal = page.getByTestId('terminal-xterm').first()
    await expect(terminal).toContainText('>', { timeout: 30_000 })

    const promptMs = Date.now() - startedAt
    console.log(JSON.stringify({ promptMs }))
    // The bundled host answers its handshake in-process. A packaged build that
    // could neither load it nor fall back would sit here until the wait gives
    // up, so this budget is about the handshake, not about raw speed.
    expect(promptMs).toBeLessThan(10_000)
  } finally {
    await app.close()
  }
})
