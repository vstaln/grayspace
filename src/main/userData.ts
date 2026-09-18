import * as electron from 'electron'

const electronApp = (electron as unknown as { app?: { getPath(name: string): string; isPackaged?: boolean } }).app

function packagedIgnoresDevOverrides(): boolean {
  try {
    if (electronApp?.isPackaged && !process.env.ORCSPACE_ALLOW_DEV_DATA) return true
  } catch {
    // Conservatively allow overrides when packaged state is unknowable (tests).
  }
  return false
}

export function getUserDataDir(): string {
  if (!packagedIgnoresDevOverrides()) {
    const overridePath = process.env.ORCSPACE_TEST_USER_DATA || process.env.ORCSPACE_DEV_USER_DATA
    if (overridePath) return overridePath
  }
  if (electronApp && typeof electronApp.getPath === 'function') {
    try {
      return electronApp.getPath('userData')
    } catch {

    }
  }
  throw new Error('Electron app is unavailable and ORCSPACE_TEST_USER_DATA is not set')
}
