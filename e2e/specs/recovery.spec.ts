import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  terminalFrame,
  waitForTerminalShell,
  waitForTerminalOutput,
  listTerminals,
  type OrcSpaceFixture
} from '../helpers/app'











test.describe('recovery', () => {
  test('a renderer reload parks and reconnects the same live shell', async () => {
    const ctx = await launchOrcSpace()
    try {
      await waitForCanvas(ctx.page)
      await ctx.page.getByTestId('canvas').click({ button: 'right', position: { x: 420, y: 260 } })
      await ctx.page.getByTestId('cm-terminal').click()
      const id = await waitForTerminalShell(ctx, ctx.page)

      const tagA = `pre-reload-${Date.now()}`
      const frame = terminalFrame(ctx.page)
      await frame.getByTestId('terminal-xterm').click()
      await frame.locator('textarea').focus()
      await ctx.page.keyboard.type(`echo ${tagA}`)
      await ctx.page.keyboard.press('Enter')
      await waitForTerminalOutput(ctx, id, (output) => output.includes(tagA))



      await ctx.page.waitForTimeout(1_500)




      await ctx.page.reload()
      await ctx.page.waitForLoadState('domcontentloaded')
      await waitForCanvas(ctx.page)

      await expect(terminalFrame(ctx.page)).toBeVisible()


      await expect
        .poll(async () => (await listTerminals(ctx)).some((t) => t.id === id), { timeout: 15_000 })
        .toBe(true)



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

  test('quitting and relaunching restores the canvas layout', async () => {
    const ctx = await launchOrcSpace()
    let titlesBefore: string[]
    try {
      await waitForCanvas(ctx.page)
      await ctx.page.getByTestId('canvas').click({ button: 'right', position: { x: 420, y: 260 } })
      await ctx.page.getByTestId('cm-terminal').click()
      await waitForTerminalShell(ctx, ctx.page)


      await ctx.page.waitForTimeout(1_500)
      titlesBefore = (await listTerminals(ctx)).map((t) => t.title).sort()
      expect(titlesBefore.length).toBeGreaterThan(0)
    } finally {

      await closeOrcSpace(ctx, { keepProfile: true })
    }




    const relaunched: OrcSpaceFixture = await launchOrcSpace({ profileDir: ctx.profileDir })
    try {
      await waitForCanvas(relaunched.page)


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
