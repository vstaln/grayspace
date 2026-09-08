import { existsSync } from 'node:fs'
import { join } from 'node:path'





export default async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appleId = process.env.APPLE_ID || process.env.APPLEID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID || process.env.APPLE_TEAMID

  if (!appleId || !appleIdPassword || !teamId) {
    console.log(' [!] Apple credentials not set (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID) — skipping notarization.')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = join(appOutDir, `${appName}.app`)

  if (!existsSync(appPath)) {
    console.warn(` [!] App bundle not found at ${appPath} — skipping notarization.`)
    return
  }

  console.log(` ==> Notarizing ${appName} with Apple Developer ID...`)
  try {
    const { notarize } = await import('@electron/notarize')
    await notarize({
      appPath,
      appleId,
      appleIdPassword,
      teamId
    })
    console.log(` [ok] Notarization complete for ${appName}`)
  } catch (error) {
    console.error(` [x] Notarization failed:`, error)
    throw error
  }
}
