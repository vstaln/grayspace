import { test, expect } from '@playwright/test'
import { launchOrcSpace, closeOrcSpace, waitForCanvas } from '../helpers/app'

test('startup is visible before the bundle loads and yields to the app', async ({}, testInfo) => {
  const ctx = await launchOrcSpace()
  let release = (): void => {}
  try {
    await waitForCanvas(ctx.page)
    for (const reduced of [false, true]) {
      await ctx.page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
      const gate = new Promise<void>((resolve) => { release = resolve })
      await ctx.page.route('**/assets/index-*.js', async (route) => {
        await gate
        await route.continue()
      }, { times: 1 })
      await ctx.page.reload({ waitUntil: 'commit' })
      const splash = ctx.page.getByRole('status', { name: 'Loading OrcSpace' })
      await expect(splash).toBeVisible()
      await expect(splash).toHaveCSS('background-color', 'rgb(8, 8, 8)')
      if (reduced) {
        await expect(splash.locator('.startup-brand')).toHaveCSS('animation-name', 'none')
      } else {
        await expect(splash.locator('.startup-brand')).toHaveCSS('opacity', '1')
        await ctx.page.screenshot({ path: testInfo.outputPath('startup.png') })
      }
      release()
      await waitForCanvas(ctx.page)
      await expect(ctx.page.locator('#startup-screen')).toHaveCount(0)
    }
  } finally {
    release()
    await closeOrcSpace(ctx)
  }
})
