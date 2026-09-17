import { test, expect } from '@playwright/test'
import { launchOrcSpace, closeOrcSpace, waitForCanvas, terminalFrame,
  waitForTerminalShell, waitForTerminalOutput } from '../helpers/app'

test('a crashed renderer reconnects to the same running shell', async () => {
  test.skip(process.platform !== 'win32', 'Windows shell environment regression')
  const ctx = await launchOrcSpace()
  const { page } = ctx
  try {
    await waitForCanvas(page)
    await page.getByTestId('canvas').click({ button: 'right', position: { x: 48, y: 72 } })
    await page.getByTestId('cm-terminal').click()
    const id = await waitForTerminalShell(ctx, page)
    const marker = `SURVIVED_${Date.now()}`
    await terminalFrame(page).locator('textarea').focus()
    await page.keyboard.type(`set ORC_CRASH_CHECK=${marker}`)
    await page.keyboard.press('Enter')
    // Typed echo may contain cursor-position sequences between characters.
    // The screen, rather than a stripped byte stream, is the observable result.
    await expect(terminalFrame(page).locator('.xterm-rows')).toContainText(marker)
    // The canvas save is debounced by about a second. Crashing before it lands
    // leaves the main process with no widget to hand back, so the reload comes
    // up on an empty canvas and this test measures save timing instead of shell
    // recovery — which is what made it fail while recovery itself worked.
    await expect
      .poll(
        () => page.evaluate(async (widgetId) => {
          const snapshot = await window.api.canvas.load()
          return snapshot.widgets.some((widget) => widget.id === widgetId)
        }, id),
        { message: 'the terminal widget must reach the main process before the crash' }
      )
      .toBe(true)
    await ctx.app.evaluate(({ BrowserWindow }) => new Promise<void>((resolve) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.once('did-finish-load', () => resolve())
      contents.forcefullyCrashRenderer()
    }))
    // Playwright keeps its Page marked crashed after Electron reloads it.
    // Inspect and type through the surviving WebContents instead.
    await expect.poll(() => ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        "!!document.querySelector('[data-testid=canvas]') && !!document.querySelector('.xterm-helper-textarea:not([disabled])') && !document.querySelector('#startup-screen')"
      )
    ), { timeout: 20_000 }).toBe(true)
    await ctx.app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      await contents.executeJavaScript("document.querySelector('.xterm-helper-textarea').focus()")
      await contents.insertText('echo AFTER_CRASH_%ORC_CRASH_CHECK%')
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    })
    await waitForTerminalOutput(ctx, id, (output) => output.includes(`AFTER_CRASH_${marker}`))
  } finally {
    await closeOrcSpace(ctx)
  }
})
