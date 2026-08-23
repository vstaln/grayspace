import * as fs from 'fs'
import { basename, dirname, extname, join, parse, resolve } from 'path'
import * as media from '../media.ts'
import { ipcMain, shell } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

const MAX_FS_READ_BYTES = 5 * 1024 * 1024

/**
 * Collapses `..`/`.` segments via path.resolve so a mutating fs handler
 * never acts on a path that differs from what the renderer displayed.
 */
const resolveTarget = (input: unknown): string | null => {
  if (typeof input !== 'string' || !input.trim()) return null
  const target = resolve(input.trim())
  // Same UNC/NTLM rule as media:data-url — a renderer-supplied \\host\share
  // must not make the main process open an SMB session.
  if (!media.isLocalPath(target)) return null
  return target
}

/**
 * Mutating fs operations go through the bus as `file.*` commands, exactly
 * like every other write: they take the normalized file lock (an agent
 * holding the path keeps the user out), land in the journal, and serialize
 * per-path on the queue instead of racing the agents' own tools. Reads stay
 * direct — they contend for nothing.
 */
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
      // Stat every entry concurrently, not one `await` per row: a folder with
      // hundreds of entries paid N sequential disk round-trips (each easily
      // 1ms+ on Windows) before the listing could render. Promise.all keeps
      // the output order identical to readdir's, and each entry keeps its own
      // zero-size fallback when its stat fails (PERF-fs-list).
      const visible = dirEntries.filter((entry) => options?.showHidden || !entry.name.startsWith('.'))
      const items = await Promise.all(
        visible.map(async (entry) => {
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
        items
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
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
        const dataUrl = await media.dataUrl(target)
        return {
          path: target,
          name: basename(target),
          isImage: true,
          dataUrl,
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
      const buffer = await fs.promises.readFile(target)
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
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('fs:write-file', async (_e, filePath: string, content: string) =>
    sendFileCommand(send, 'file.write', filePath, { content: String(content ?? '') })
  )

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
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('fs:open-path', async (_e, targetPath: string) => {
    try {
      const target = resolveTarget(targetPath)
      if (!target) return { error: 'Invalid path' }
      const err = await shell.openPath(target)
      if (err) return { error: err }
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
