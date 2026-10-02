import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import { launchPackaged, packagedExecutable } from '../helpers/packaged'
import { terminalFrame, waitForCanvas } from '../helpers/app'
import { runInterruptScenario, visibleRows, type ScenarioShell } from '../helpers/interruptScenario'

// The Ctrl+C regression shipped in installers while the dev build looked
// fixed, so this runs against the packaged app electron-builder produced (the
// same app.asar, native engine and bundled ConPTY the installer ships), not
// against `out/` under a dev Electron.
const shells: ScenarioShell[] = process.platform === 'win32' ? ['cmd', 'powershell'] : ['posix']

for (const shell of shells) {
  test(`packaged: Ctrl+C after a TUI leaves the next ${shell} prompt at the live bottom`, async () => {
    test.setTimeout(240_000)
    const executable = packagedExecutable()
    test.skip(!fs.existsSync(executable), `packaged executable is not present: ${executable}; package the app first`)
    const app = await launchPackaged()
    try {
      const { page } = app
      await waitForCanvas(page)
      if (process.platform === 'win32') {
        await page.evaluate((windowsShell) => window.api.settings.set({ windowsShell }), shell as 'cmd' | 'powershell')
      }
      await page.getByTestId('canvas').click({ button: 'right', position: { x: 420, y: 260 } })
      await page.getByTestId('cm-terminal').click()
      const xterm = terminalFrame(page).getByTestId('terminal-xterm')
      const prompt = process.platform === 'win32' ? />\s*$/ : /[$#]\s*$/
      await expect.poll(async () => (await visibleRows(xterm)).some((row) => prompt.test(row)), { timeout: 60_000 }).toBe(true)
      await runInterruptScenario(page, xterm, shell)
    } finally {
      await app.close()
    }
  })
}
