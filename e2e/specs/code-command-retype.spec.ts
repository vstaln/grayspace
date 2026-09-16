import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, controlGet } from '../helpers/app'

/**
 * Reloading the window must not retype the agent command into a running agent.
 *
 * The queue that holds a session's agent command lives in the renderer, and so
 * does the record of what has already been typed. A window reload keeps the
 * main process — and therefore the ptys — alive while clearing both, so every
 * restored session re-queues its command and connects to a pty that is already
 * running the agent. Typed there, `codex resume <id>` lands in the agent's
 * composer as literal text instead of starting anything.
 *
 * The fake agent stands in for a real one: it takes the alternate screen, the
 * way every agent TUI does, and reports each keystroke it is handed.
 */
test('a window reload does not retype the agent command into a running agent', async () => {
  test.setTimeout(240_000)
  const ctx = await launchOrcSpace()
  try {
    const { page, profileDir } = ctx
    const fake = path.join(profileDir, 'fake-agent.js')
    fs.writeFileSync(fake, [
      `process.stdout.write('\\u001b[?1049hAGENT-UP')`,
      `process.stdin.setEncoding('utf8')`,
      `process.stdin.on('data', (d) => process.stdout.write('GOT:' + JSON.stringify(d)))`,
      `setInterval(() => {}, 1000)`
    ].join('\n'))

    await waitForCanvas(page)
    await page.evaluate(() => window.api.workspace.create(`retype-${Date.now()}`))
    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    await page.evaluate(async (cmd) => {
      const workspace = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({
        codeWorkspaceId: workspace.activeId,
        sessions: [
          { id: 'retype-1', agentId: 'custom', label: 'Fake agent', command: cmd, status: 'active' as const }
        ]
      })
    }, `node ${fake}`)

    const restore = page.getByRole('button', { name: /^Restore \d+/ })
    await restore.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    if (await restore.count()) await restore.click()
    await expect(page.locator('[data-testid="code-session"]')).toHaveCount(1)

    const output = async (): Promise<string> =>
      String((await controlGet(ctx, '/terminal/retype-1/output?full=1')).output ?? '')
    const keystrokes = (text: string): number => text.split('GOT:').length - 1

    await expect.poll(async () => (await output()).includes('AGENT-UP'), { timeout: 60_000 }).toBe(true)
    const before = keystrokes(await output())

    await page.reload()
    await page.locator('#startup-screen').waitFor({ state: 'detached', timeout: 60_000 })
    const restoreAgain = page.getByRole('button', { name: /^Restore \d+/ })
    await restoreAgain.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    if (await restoreAgain.count()) await restoreAgain.click({ timeout: 30_000 })
    await expect(page.locator('[data-testid="code-session"]')).toHaveCount(1)
    // The command is typed shortly after the widget connects; this is well
    // past that, so a zero here means it was never sent rather than late.
    await page.waitForTimeout(8000)

    expect(keystrokes(await output())).toBe(before)
  } finally {
    await closeOrcSpace(ctx)
  }
})
