import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const profile = mkdtempSync(join(tmpdir(), 'orcspace-ui-reference-'))
const output = resolve('artifacts/ui-reference')
mkdirSync(output, { recursive: true })
const app = await electron.launch({
  args: [resolve('out/main/index.js'), `--user-data-dir=${profile}`, '--disable-gpu'],
  env: { ...process.env, ORCSPACE_TEST_USER_DATA: profile, WORKSPACE_CONTROL_PORT: '0' },
  timeout: 60_000
})
try {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setSize(1440, 920)
      window.setPosition(-20000, 0)
    }
  })
  await page.getByTestId('canvas').waitFor({ state: 'visible', timeout: 45_000 })
  await page.locator('#startup-screen').waitFor({ state: 'detached' })
  await page.screenshot({ path: join(output, 'canvas.png') })
  await page.getByRole('tab', { name: 'Code', exact: true }).click()
  await page.getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' })
  await page.getByTestId('code-view').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(output, 'code.png') })
  await page.evaluate(() => window.dispatchEvent(new Event('orcspace:open-settings')))
  await page.getByRole('dialog').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(output, 'settings.png') })
  console.log(`UI reference: ${output}`)
} finally {
  await app.close()
}
