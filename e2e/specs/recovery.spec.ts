import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  terminalFrame,
  waitForTerminalShell,
  waitForTerminalOutput,
  listTerminals,
  controlGet,
  controlSend,
  type OrcSpaceFixture
} from '../helpers/app'

/**
 * Recovery and concurrency journeys the older specs never touched:
 *
 *  1. The renderer reloads (the same code path a renderer crash takes: PTYs
 *     are parked in main, the canvas rehydrates, widgets reconnect) and the
 *     shell session survives — same pty, scrollback intact, still accepting
 *     keystrokes.
 *  2. A burst of concurrent board writes through the control API serialises
 *     on the command bus without losing or duplicating anything, and a stale
 *     baseVersion is rejected with a conflict instead of clobbering.
 *  3. Quitting and relaunching restores the canvas layout from disk.
 */

test.describe('recovery', () => {
  test('a renderer reload parks and reconnects the same live shell', async () => {
    const ctx = await launchOrcSpace()
    try {
      await waitForCanvas(ctx.page)
      await ctx.page.getByTestId('rail-new-terminal').click()
      const id = await waitForTerminalShell(ctx, ctx.page)

      const tagA = `pre-reload-${Date.now()}`
      const frame = terminalFrame(ctx.page)
      await frame.getByTestId('terminal-xterm').click()
      await frame.locator('textarea').focus()
      await ctx.page.keyboard.type(`echo ${tagA}`)
      await ctx.page.keyboard.press('Enter')
      await waitForTerminalOutput(ctx, id, (output) => output.includes(tagA))

      // Let the debounced canvas save (800 ms) round-trip so the widget is
      // part of main's snapshot before the renderer goes away.
      await ctx.page.waitForTimeout(1_500)

      // A reload exercises the same recovery path as a renderer crash:
      // main keeps the pty, the canvas hydrates, the widget remounts and
      // reconnects to the parked process instead of spawning a fresh one.
      await ctx.page.reload()
      await ctx.page.waitForLoadState('domcontentloaded')
      await waitForCanvas(ctx.page)

      await expect(terminalFrame(ctx.page)).toBeVisible()
      // Remount → terminal:create → spawn reconnects asynchronously, so poll
      // until the parked pty is back among live terminals.
      await expect
        .poll(async () => (await listTerminals(ctx)).some((t) => t.id === id), { timeout: 15_000 })
        .toBe(true)

      // The reconnected pane must still be the SAME shell: a second echo
      // lands in the one buffer that already holds the first tag.
      const tagB = `post-reload-${Date.now()}`
      const reconnected = terminalFrame(ctx.page)
      await reconnected.getByTestId('terminal-xterm').click()
      await reconnected.locator('textarea').focus()
      await ctx.page.keyboard.type(`echo ${tagB}`)
      await ctx.page.keyboard.press('Enter')
      const output = await waitForTerminalOutput(
        ctx,
        id,
        (text) => text.includes(tagA) && text.includes(tagB)
      )
      expect(output.indexOf(tagA)).toBeLessThan(output.indexOf(tagB))
    } finally {
      await closeOrcSpace(ctx)
    }
  })

  test('concurrent board writes serialize; a stale baseVersion conflicts', async () => {
    const ctx = await launchOrcSpace()
    try {
      await waitForCanvas(ctx.page)

      // Ten writers hit the loopback API at once. Every command funnels
      // through the bus's single lane, so none may be dropped, duplicated,
      // or answered twice.
      const burst = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          controlSend(ctx, 'POST', '/coordination/tasks', {
            agentId: 'race-agent',
            title: `race-${i}-${Date.now()}`,
            state: 'queued'
          })
        )
      )
      for (const res of burst) {
        // task.create answers 201 Created by design (see controlServer's
        // reply status for note/task/plan/widget creates).
        expect(res.status).toBe(201)
        expect(res.json?.ok).toBe(true)
      }
      const ids = burst.map((r) => r.json.data.id as string)
      expect(new Set(ids).size).toBe(10)

      // An optimistic-concurrency check: a patch carrying a version nobody
      // has seen must bounce with 409, then succeed once it carries the
      // version the board actually has.
      const status = await controlGet(ctx, '/coordination/status')
      const task = status.tasks.find((t: { id: string }) => t.id === ids[0])
      expect(task).toBeTruthy()

      const stale = await controlSend(ctx, 'PATCH', `/coordination/tasks/${ids[0]}`, {
        agentId: 'race-agent',
        baseVersion: task.version + 100,
        state: 'done'
      })
      expect(stale.status).toBe(409)
      expect(stale.json?.code).toBe('conflict')

      const fresh = await controlSend(ctx, 'PATCH', `/coordination/tasks/${ids[0]}`, {
        agentId: 'race-agent',
        baseVersion: task.version,
        state: 'done'
      })
      expect(fresh.status).toBe(200)
      expect(fresh.json?.ok).toBe(true)
    } finally {
      await closeOrcSpace(ctx)
    }
  })

  test('quitting and relaunching restores the canvas layout', async () => {
    const ctx = await launchOrcSpace()
    let titlesBefore: string[]
    try {
      await waitForCanvas(ctx.page)
      await ctx.page.getByTestId('rail-new-terminal').click()
      await waitForTerminalShell(ctx, ctx.page)
      // The widget reaches main through the debounced canvas import; give it
      // time to land before the quit path flushes everything to disk.
      await ctx.page.waitForTimeout(1_500)
      titlesBefore = (await listTerminals(ctx)).map((t) => t.title).sort()
      expect(titlesBefore.length).toBeGreaterThan(0)
    } finally {
      // Keep the profile: the relaunch below boots from exactly this state.
      await closeOrcSpace(ctx, { keepProfile: true })
    }

    // Fresh ports for the second instance; the profile is what carries state.
    // (The auto-launched "Claude" terminal of a fresh boot adds its own widget
    // again, so exact counts would double-count — titles are what must survive.)
    const relaunched: OrcSpaceFixture = await launchOrcSpace({ profileDir: ctx.profileDir })
    try {
      await waitForCanvas(relaunched.page)
      // The old ptys died with the previous process; every persisted widget
      // comes back from the canvas store and starts a fresh shell in place.
      await expect
        .poll(
          async () => {
            const restored = (await listTerminals(relaunched)).map((t) => t.title)
            return titlesBefore.every((title) => restored.includes(title))
          },
          { timeout: 20_000 }
        )
        .toBe(true)
    } finally {
      await closeOrcSpace(relaunched)
    }
  })
})
