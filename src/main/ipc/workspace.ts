import * as fs from 'fs'
import * as pathModule from 'path'
import { dialog, ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'
import { isLocalPath } from '../media.ts'
import { getUserDataDir } from '../userData.ts'

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



  ipcMain.handle('workspace:create', async (_e, rawName: unknown) => {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    if (!name || name.length > 80 || name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
      return { error: 'Enter a valid workspace name.' }
    }
    try {
      const root = pathModule.join(getUserDataDir(), 'workspaces')
      await fs.promises.mkdir(root, { recursive: true })
      const target = pathModule.join(root, name)
      await fs.promises.mkdir(target)
      deps.setWorkspaceDir(target)
      return target
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') return { error: 'A workspace with this name already exists.' }
      return { error: err instanceof Error ? err.message : 'Could not create workspace.' }
    }
  })

  ipcMain.handle('workspace:rename', (_e, rawPath: unknown, rawName: unknown) => {
    if (typeof rawPath !== 'string' || !isLocalPath(rawPath) || typeof rawName !== 'string') return { error: 'Invalid workspace.' }
    return deps.state.renameRecent(rawPath, rawName)
  })

  ipcMain.handle('workspace:code-workspaces', () => deps.state.codeWorkspaceState(deps.getWorkspaceDir()))
  ipcMain.handle('workspace:code-workspace-groups', () => {
    const current = deps.getWorkspaceDir()
    const recent = deps.state.get().recent
    const folders = current && !recent.some((entry) => entry.path === current)
      ? [{ path: current, name: pathModule.basename(current) || current }, ...recent]
      : recent
    return folders.map((entry) => ({
      ...deps.state.codeWorkspaceState(entry.path),
      folder: entry.path,
      name: entry.name
    }))
  })
  ipcMain.handle('workspace:create-code', (_e, rawName: unknown) => {
    const folder = deps.getWorkspaceDir()
    const result = deps.state.createCodeWorkspace(folder, typeof rawName === 'string' ? rawName : undefined)
    if ('error' in result) return result
    deps.code.setWorkspaceScope(deps.state.activeCodeWorkspaceScope(folder))
    const next = deps.state.codeWorkspaceState(folder)
    deps.getWindow()?.webContents.send('workspace:onCodeWorkspaceChange', next)
    return result
  })
  ipcMain.handle('workspace:rename-code', (_e, rawId: unknown, rawName: unknown) => {
    if (typeof rawId !== 'string' || typeof rawName !== 'string') return { error: 'Invalid workspace.' }
    const result = deps.state.renameCodeWorkspace(deps.getWorkspaceDir(), rawId, rawName)
    if (!('error' in result)) deps.getWindow()?.webContents.send('workspace:onCodeWorkspaceChange', result)
    return result
  })
  ipcMain.handle('workspace:delete-code', (_e, rawId: unknown) => {
    if (typeof rawId !== 'string') return { error: 'Invalid workspace.' }
    const folder = deps.getWorkspaceDir()
    const result = deps.state.deleteCodeWorkspace(folder, rawId)
    if ('error' in result) return result
    deps.code.setWorkspaceScope(
      deps.state.activeCodeWorkspaceScope(folder),
      result.activeId === result.workspaces[0]?.id ? folder : undefined
    )
    deps.getWindow()?.webContents.send('workspace:onCodeWorkspaceChange', result)
    return result
  })
  ipcMain.handle('workspace:select-code', (_e, rawId: unknown) => {
    if (typeof rawId !== 'string') return { error: 'Invalid workspace.' }
    const folder = deps.getWorkspaceDir()
    const result = deps.state.setActiveCodeWorkspace(folder, rawId)
    if ('error' in result) return result
    deps.code.setWorkspaceScope(
      deps.state.activeCodeWorkspaceScope(folder),
      result.activeId === result.workspaces[0]?.id ? folder : undefined
    )
    deps.getWindow()?.webContents.send('workspace:onCodeWorkspaceChange', result)
    return result
  })


  ipcMain.handle('workspace:recent', () => deps.state.get().recent)

  ipcMain.handle('workspace:open-recent', (_e, path: string) => {



    if (typeof path !== 'string' || !isLocalPath(path) || !fs.existsSync(path)) {
      deps.state.removeRecent(String(path))
      return { error: 'Folder unavailable' }
    }



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
    if (typeof path !== 'string' || !isLocalPath(path)) return { error: 'Invalid path' }
    deps.state.togglePin(path)
    return deps.state.get().recent
  })
  ipcMain.handle('workspace:forget-recent', (_e, path: string) => {
    if (typeof path !== 'string' || !isLocalPath(path)) return { error: 'Invalid path' }
    deps.state.removeRecent(path)
    return deps.state.get().recent
  })
}
