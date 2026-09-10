import * as fs from 'fs'
import { basename, dirname, extname, join, parse, resolve } from 'path'
import * as media from '../media.ts'
import { ipcMain, shell } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

const MAX_FS_READ_BYTES = 5 * 1024 * 1024





const resolveTarget = (input: unknown): string | null => {
  if (typeof input !== 'string' || !input.trim()) return null
  const target = resolve(input.trim())


  if (!media.isLocalPath(target)) return null
  return target
}








async function sendFileCommand(
  send: ReturnType<typeof makeSend>,
  type: string,
  filePath: string,
  payload: Record<string, string>
): Promise<{ ok: boolean; error?: string; code?: string }> {
  const target = resolveTarget(filePath)
  if (!target) return { ok: false, error: 'Invalid path' }
  const data = unwrap(await send<Record<string, never>>(type, `file:${target}`, { ...payload, path: target }))
  if (!('error' in data)) return { ok: true }
  return { ok: false, error: String(data.error), ...(typeof data.code === 'string' ? { code: data.code } : {}) }
}

export function registerFilesystemIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('fs:list', async (_e, dirPath?: string, options?: { showHidden?: boolean }) => {
    try {
      const requested = dirPath && dirPath.trim() ? dirPath.trim() : (deps.getWorkspaceDir() ?? process.cwd())
      const targetDir = resolveTarget(requested)
      if (!targetDir || !fs.existsSync(targetDir)) {
        return { error: 'Folder does not exist or workspace is not selected' }
      }
      const dirStat = await fs.promises.stat(targetDir)
      if (!dirStat.isDirectory()) {
        return { error: 'Target path is not a directory' }
      }
      const dirEntries = await fs.promises.readdir(targetDir, { withFileTypes: true })





      const visible = dirEntries.filter((entry) => options?.showHidden || !entry.name.startsWith('.'))


      const MAX_LIST_ENTRIES = 2_000
      const truncated = visible.length > MAX_LIST_ENTRIES
      const slice = visible.slice(0, MAX_LIST_ENTRIES)
      const items: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean; ext: string; size: number; mtime: number }> = []
      for (let i = 0; i < slice.length; i += 100) {
        const batch = await Promise.all(
          slice.slice(i, i + 100).map(async (entry) => {
            const fullPath = join(targetDir, entry.name)
            const base = {
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              isFile: entry.isFile(),
              isSymbolicLink: entry.isSymbolicLink(),
              ext: entry.isFile() ? extname(entry.name).toLowerCase() : ''
            }
            try {
              const itemStat = await fs.promises.stat(fullPath)
              return { ...base, size: itemStat.size, mtime: itemStat.mtimeMs }
            } catch {
              return { ...base, size: 0, mtime: 0 }
            }
          })
        )
        items.push(...batch)
      }
      items.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) {
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        }
        return a.isDirectory ? -1 : 1
      })
      const parsedPath = parse(targetDir)
      const parentPath = targetDir === parsedPath.root ? null : dirname(targetDir)
      return {
        currentPath: targetDir,
        parentPath,
        items,
        truncated
      }
    } catch {


      return { error: 'Unable to list this folder' }
    }
  })

  ipcMain.handle('fs:read-file', async (_e, filePath: string, maxBytes = MAX_FS_READ_BYTES) => {
    try {
      const target = resolveTarget(filePath)
      if (!target || !fs.existsSync(target)) return { error: 'File does not exist' }
      const cap = Math.min(MAX_FS_READ_BYTES, Math.max(1, Number(maxBytes) || MAX_FS_READ_BYTES))
      const stat = await fs.promises.stat(target)
      if (!stat.isFile()) return { error: 'Path is not a regular file' }
      const ext = extname(target).toLowerCase()
      const isImg = media.hasImageExtension(target)
      if (isImg) {



        if (stat.size > media.MAX_DATA_URL_BYTES) {
          return { error: `File is too large to preview (${(stat.size / (1024 * 1024)).toFixed(1)} MB).` }
        }
        const buffer = await fs.promises.readFile(target)
        return {
          path: target,
          name: basename(target),
          isImage: true,
          dataUrl: `data:${media.mimeTypeForPath(target)};base64,${buffer.toString('base64')}`,
          size: stat.size,
          mtime: stat.mtimeMs,
          ext
        }
      }
      if (stat.size > cap) {
        return {
          error: `File is too large to preview (${(stat.size / (1024 * 1024)).toFixed(1)} MB). Limit is ${(cap / (1024 * 1024)).toFixed(0)} MB.`
        }
      }



      const handle = await fs.promises.open(target, 'r')
      let buffer: Buffer
      try {
        const { bytesRead, buffer: buf } = await handle.read(Buffer.allocUnsafe(cap + 1), 0, cap + 1, 0)
        buffer = buf.subarray(0, bytesRead)
      } finally {
        await handle.close().catch(() => {})
      }
      if (buffer.length > cap) {
        return {
          error: `File is too large to preview. Limit is ${(cap / (1024 * 1024)).toFixed(0)} MB.`
        }
      }
      const isBinary = buffer.includes(0)
      if (isBinary) {
        return {
          path: target,
          name: basename(target),
          isBinary: true,
          size: stat.size,
          mtime: stat.mtimeMs,
          ext
        }
      }
      return {
        path: target,
        name: basename(target),
        content: buffer.toString('utf8'),
        isBinary: false,
        size: stat.size,
        mtime: stat.mtimeMs,
        ext
      }
    } catch {
      return { error: 'Unable to read this file' }
    }
  })

  ipcMain.handle('fs:write-file', async (_e, filePath: string, content: string) => {
    const text = String(content ?? '')
    if (Buffer.byteLength(text, 'utf8') > 50 * 1024 * 1024) return { error: 'content exceeds 50 MB' }
    return sendFileCommand(send, 'file.write', filePath, { content: text })
  })

  ipcMain.handle('fs:create-file', async (_e, filePath: string) => sendFileCommand(send, 'file.create', filePath, {}))

  ipcMain.handle('fs:create-dir', async (_e, dirPath: string) => sendFileCommand(send, 'file.mkdir', dirPath, {}))

  ipcMain.handle('fs:delete', async (_e, targetPath: string) => sendFileCommand(send, 'file.delete', targetPath, {}))

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
    const source = resolveTarget(oldPath)
    const destination = resolveTarget(newPath)
    if (!source || !destination) return { ok: false, error: 'Invalid path' }
    const data = unwrap(
      await send<Record<string, never>>('file.rename', `file:${source}`, { path: source, to: destination })
    )
    if (!('error' in data)) return { ok: true }
    return { ok: false, error: String(data.error), ...(typeof data.code === 'string' ? { code: data.code } : {}) }
  })

  ipcMain.handle('fs:reveal', async (_e, targetPath: string) => {
    try {
      const target = resolveTarget(targetPath)
      if (!target) return { error: 'Invalid path' }
      if (fs.existsSync(target)) {
        shell.showItemInFolder(target)
        return { ok: true }
      }
      return { error: 'File or folder does not exist' }
    } catch {
      return { error: 'Unable to reveal this path' }
    }
  })


  const EXECUTABLE_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.vbs', '.vbe',
    '.js', '.jse', '.wsf', '.wsh', '.jar', '.sh', '.bash', '.lnk', '.reg',
    '.hta', '.msc', '.cpl', '.url', '.inf', '.pif', '.appref-ms', '.wsb', '.mof', '.gadget'
  ])

  ipcMain.handle('fs:open-path', async (_e, targetPath: string) => {
    try {
      const target = resolveTarget(targetPath)
      if (!target) return { error: 'Invalid path' }

      const candidates = new Set([target, target.replace(/[. ]+$/, '')])
      try {
        candidates.add(fs.realpathSync(target))
      } catch {

      }
      for (const candidate of candidates) {
        if (EXECUTABLE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
          return { error: 'Executable files cannot be opened from here' }
        }
      }
      const err = await shell.openPath(target)
      if (err) return { error: 'Unable to open this path' }
      return { ok: true }
    } catch {
      return { error: 'Unable to open this path' }
    }
  })
}
