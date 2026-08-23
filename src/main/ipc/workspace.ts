import * as fs from 'fs'
import { dialog, ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'
import { isLocalPath } from '../media.ts'

export function registerWorkspaceIpc(deps: IpcDeps): void {
  ipcMain.handle('workspace:get-dir', () => deps.getWorkspaceDir() ?? null)
  ipcMain.handle('workspace:pick-dir', async () => {
    const window = deps.getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return deps.getWorkspaceDir() ?? null
    deps.setWorkspaceDir(result.filePaths[0])
    return result.filePaths[0]
  })

  // ---- remembered project folders ----------------------------------------
  ipcMain.handle('workspace:recent', () => deps.state.get().recent)
  /** Reopens a folder already in the list without going through the OS dialog. */
  ipcMain.handle('workspace:open-recent', (_e, path: string) => {
    // isLocalPath rejects UNC/network paths: existsSync('\\\\host\\share')
    // would make the main process initiate an SMB connection (NTLM hash leak),
    // and a network location must not become the workspace dir.
    if (typeof path !== 'string' || !isLocalPath(path) || !fs.existsSync(path)) {
      deps.state.removeRecent(String(path))
      return { error: 'Folder unavailable' }
    }
    // Same rule handleSecondInstanceArgs applies to argv: a file must not
    // become the workspace dir — terminals would silently fall back to the
    // home directory while the UI claims the file's folder is open.
    try {
      if (!fs.statSync(path).isDirectory()) return { error: 'Not a folder' }
    } catch {
      deps.state.removeRecent(path)
      return { error: 'Folder unavailable' }
    }
    deps.setWorkspaceDir(path)
    return path
  })
  ipcMain.handle('workspace:pin-recent', (_e, path: string) => {
    deps.state.togglePin(path)
    return deps.state.get().recent
  })
  ipcMain.handle('workspace:forget-recent', (_e, path: string) => {
    deps.state.removeRecent(path)
    return deps.state.get().recent
  })
}
