import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace } from '../helpers/app'

/**
 * How long a terminal takes to show its first prompt, measured the way the user
 * experiences it: from asking for the session to the shell's prompt on screen.
 *
 * The regression this guards is not a slow PTY — spawning one takes tens of
 * milliseconds. ConPTY opens a session by asking the terminal where the cursor
 * is (`ESC [ 6 n`) and holds back every byte the shell writes until it is
 * answered. While that answer came from xterm.js, it had to travel engine ->
 * main -> renderer -> parser and back, so the window appeared instantly and
 * then sat blank for seconds. The engine answers the handshake itself now
 * (prime_conpty_handshake in native/orcspace-app/src/engine.rs).
 *
 * The budget is deliberately far above a healthy start (a few hundred ms) and
 * far below the broken one, so it fails on the bug rather than on a slow
 * machine.
 */
const PROMPT_BUDGET_MS = 2_000

test('a Code terminal reaches its prompt without waiting on the renderer', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.evaluate(() => window.api.workspace.create(`terminal-startup-${Date.now()}`))
    await page.getByRole('tab', { name: 'Code', exact: true }).click()

    const startedAt = Date.now()
    await page.evaluate(async () => {
      const workspace = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({
        codeWorkspaceId: workspace.activeId,
        sessions: [{ id: 'startup-shell', agentId: 'custom', label: 'Shell', command: '', status: 'active' as const }]
      })
    })

    const terminal = page.getByTestId('terminal-xterm').first()
    await expect(terminal).toContainText('>')
    const elapsed = Date.now() - startedAt

    console.log(JSON.stringify({ promptMs: elapsed }))
    expect(elapsed, 'the shell prompt must not wait on a renderer round trip').toBeLessThan(PROMPT_BUDGET_MS)
  } finally {
    await closeOrcSpace(ctx)
  }
})
