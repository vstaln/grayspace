import * as fs from 'fs'
import { CommandError, fileResource, parseResource } from '../core/index.ts'
import { isLocalPath, resolveInWorkspaceSync } from '../media.ts'
import { writeTextAtomicAsync } from '../storage.ts'
import type { CommandDeps } from './index.ts'


const MAX_FILE_WRITE_BYTES = 50 * 1024 * 1024

















function assertTargetMatches(target: string, absPath: string): void {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'file') throw new CommandError('invalid', `${target} is not a file resource`)
  if (fileResource(absPath) !== target) {
    throw new CommandError('invalid', `target ${target} does not match payload path`)
  }
}

/**
 * Filesystem jail: every file command must stay inside the workspace.
 * Deny-by-default — no workspace, non-local path, or realpath escaping
 * the workspace root is refused before any fs call.
 */
function jail(rawPath: unknown, workspaceDir: string | undefined, what = 'path'): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new CommandError('invalid', `${what} is required`)
  const abs = rawPath.trim()
  if (!isLocalPath(abs)) throw new CommandError('invalid', 'only local absolute paths are allowed')
  if (!workspaceDir) throw new CommandError('invalid', 'workspace is not selected — path denied by default')
  const contained = resolveInWorkspaceSync(abs, workspaceDir)
  if (!contained) throw new CommandError('invalid', 'path escapes workspace — denied')
  return contained
}

const PATH_FIELD = {
  type: 'string' as const,
  description: 'Absolute local path (UNC/network paths are refused)'
}

export function registerFileCommands(deps: CommandDeps): void {
  const { flow } = deps.core
  const workspaceOf = (): string | undefined => {
    try {
      return deps.defaultCwd?.()
    } catch {
      return undefined
    }
  }

  flow.registerDefinition<{ path: string; content: string }, { ok: true }>({
    type: 'file.write',
    description: 'Create or overwrite a UTF-8 text file.',
    targetScheme: 'file',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: PATH_FIELD, content: { type: 'string', description: 'Full file contents' } }
    },
    handler: {
      apply: async ({ command }) => {
        const raw = (command.payload as { path?: unknown }).path
        const abs = jail(raw, workspaceOf())
        assertTargetMatches(command.target, abs)
        const content = String((command.payload as { content?: unknown }).content ?? '')
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_WRITE_BYTES) {
          throw new CommandError('invalid', `content exceeds ${MAX_FILE_WRITE_BYTES} bytes`)
        }
        try {


          await writeTextAtomicAsync(abs, content)
          return { ok: true }
        } catch (err) {
          throw new CommandError('failed', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  flow.registerDefinition<{ path: string }, { ok: true }>({
    type: 'file.create',
    description: 'Create an empty file; fails if it already exists.',
    targetScheme: 'file',
    ignoreVersion: true,
    payloadSchema: { type: 'object', required: ['path'], properties: { path: PATH_FIELD } },
    handler: {
      apply: async ({ command }) => {
        const raw = command.payload?.path
        const abs = jail(raw, workspaceOf())
        assertTargetMatches(command.target, abs)
        try {
          // 'wx' opens exclusively: it fails with EEXIST instead of silently
          // truncating a file another process created between an existsSync
          // check and the write. This closes the create/overwrite race.
          await fs.promises.writeFile(abs, '', { encoding: 'utf8', flag: 'wx' })
          return { ok: true }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code === 'EEXIST') throw new CommandError('failed', 'File already exists')
          throw new CommandError('failed', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  flow.registerDefinition<{ path: string }, { ok: true }>({
    type: 'file.mkdir',
    description: 'Create a folder (parents included); fails if it already exists.',
    targetScheme: 'file',
    ignoreVersion: true,
    payloadSchema: { type: 'object', required: ['path'], properties: { path: PATH_FIELD } },
    handler: {
      apply: async ({ command }) => {
        const raw = command.payload?.path
        const abs = jail(raw, workspaceOf())
        assertTargetMatches(command.target, abs)
        if (fs.existsSync(abs)) throw new CommandError('failed', 'Folder already exists')
        try {
          await fs.promises.mkdir(abs, { recursive: true })
          return { ok: true }
        } catch (err) {
          throw new CommandError('failed', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  flow.registerDefinition<{ path: string }, { ok: true }>({
    type: 'file.delete',
    description: 'Delete a file, or a folder with everything inside it.',
    targetScheme: 'file',
    ignoreVersion: true,
    payloadSchema: { type: 'object', required: ['path'], properties: { path: PATH_FIELD } },
    handler: {
      apply: async ({ command }) => {
        const raw = command.payload?.path
        const abs = jail(raw, workspaceOf())
        assertTargetMatches(command.target, abs)
        if (!fs.existsSync(abs)) throw new CommandError('not_found', 'Target does not exist')
        try {
          const stat = await fs.promises.lstat(abs)
          if (stat.isSymbolicLink()) throw new CommandError('invalid', 'refusing to delete a symlink')
          if (stat.isDirectory()) await fs.promises.rm(abs, { recursive: true, force: true })
          else await fs.promises.unlink(abs)
          return { ok: true }
        } catch (err) {
          if (err instanceof CommandError) throw err
          throw new CommandError('failed', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  flow.registerDefinition<{ path: string; to: string }, { ok: true }>({
    type: 'file.rename',
    description: 'Rename or move a file/folder. The target is the source; `to` is the destination.',
    targetScheme: 'file',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['path', 'to'],
      properties: { path: PATH_FIELD, to: { ...PATH_FIELD, description: 'Destination path' } }
    },
    handler: {
      // The destination is a resource this command touches too, not just
      // the source. Without this, a lock held on the destination path (by
      // another actor's file.create/write) is invisible to this rename and
      // gets silently overwritten. Declaring it here makes assertUnlockedFor
      // and the implicit-lock machinery treat it the same as the source.
      extraLocks: (command) => {
        const to = command.payload?.to
        if (typeof to !== 'string' || !to.trim()) return []
        const destination = to.trim()
        return isLocalPath(destination) ? [fileResource(destination)] : []
      },
      apply: async ({ command }) => {
        const ws = workspaceOf()
        const raw = command.payload?.path
        const rawTo = command.payload?.to
        const source = jail(raw, ws)
        if (typeof rawTo !== 'string' || !rawTo.trim()) throw new CommandError('invalid', 'to is required')
        const destination = jail(rawTo, ws, 'to')
        assertTargetMatches(command.target, source)
        if (!fs.existsSync(source)) throw new CommandError('not_found', 'Source file does not exist')
        const isSameFileCaseOnly =
          (process.platform === 'win32' || process.platform === 'darwin') &&
          source.toLowerCase() === destination.toLowerCase()
        if (fs.existsSync(destination) && !isSameFileCaseOnly) {
          throw new CommandError('failed', 'Target file name already exists')
        }
        try {
          await fs.promises.rename(source, destination)
          return { ok: true }
        } catch (err) {
          throw new CommandError('failed', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })
}
