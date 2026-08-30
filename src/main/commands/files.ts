import * as fs from 'fs'
import { CommandError, fileResource, parseResource } from '../core/index.ts'
import { isLocalPath } from '../media.ts'
import type { CommandDeps } from './index.ts'

/**
 * Filesystem mutation as commands.
 *
 * The renderer's old fs handlers wrote straight to disk: no lock, no journal,
 * no version gate — while agents edited the same tree from their own tools.
 * Routing every mutation through the bus closes that hole: a write takes the
 * normalized `file:` lock (so an agent holding the file keeps the user out,
 * same as terminals), lands in the journal (attributed, replayable), and its
 * lane serializes concurrent writers to one path while leaving every other
 * path untouched.
 *
 * The target is the lock/lane identity; the payload carries the original
 * spelling of the path, because the bus lower-cases targets and a Linux drive
 * would not forgive writing to the folded name. A mismatch between the two is
 * refused — locking file:A must never be able to justify writing file:B.
 */
function assertTargetMatches(target: string, absPath: string): void {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'file') throw new CommandError('invalid', `${target} is not a file resource`)
  if (fileResource(absPath) !== target) {
    throw new CommandError('invalid', `target ${target} does not match payload path`)
  }
}

const PATH_FIELD = {
  type: 'string' as const,
  description: 'Absolute local path (UNC/network paths are refused)'
}

export function registerFileCommands({ core }: CommandDeps): void {
  const { bus } = core

  bus.registerDefinition<{ path: string; content: string }, { ok: true }>({
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
        if (typeof raw !== 'string' || !raw.trim()) throw new CommandError('invalid', 'path is required')
        const abs = raw.trim()
        if (!isLocalPath(abs)) throw new CommandError('invalid', 'only local absolute paths are allowed')
        assertTargetMatches(command.target, abs)
        try {
          await fs.promises.writeFile(abs, String((command.payload as { content?: unknown }).content ?? ''), 'utf8')
          return { ok: true }
        } catch (err) {
          throw new CommandError('failed', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  bus.registerDefinition<{ path: string }, { ok: true }>({
    type: 'file.create',
    description: 'Create an empty file; fails if it already exists.',
    targetScheme: 'file',
    ignoreVersion: true,
    payloadSchema: { type: 'object', required: ['path'], properties: { path: PATH_FIELD } },
    handler: {
      apply: async ({ command }) => {
        const raw = command.payload?.path
        if (typeof raw !== 'string' || !raw.trim()) throw new CommandError('invalid', 'path is required')
        const abs = raw.trim()
        if (!isLocalPath(abs)) throw new CommandError('invalid', 'only local absolute paths are allowed')
        assertTargetMatches(command.target, abs)
        if (fs.existsSync(abs)) throw new CommandError('failed', 'File already exists')
        try {
          await fs.promises.writeFile(abs, '', 'utf8')
          return { ok: true }
        } catch (err) {
          throw new CommandError('failed', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  bus.registerDefinition<{ path: string }, { ok: true }>({
    type: 'file.mkdir',
    description: 'Create a folder (parents included); fails if it already exists.',
    targetScheme: 'file',
    ignoreVersion: true,
    payloadSchema: { type: 'object', required: ['path'], properties: { path: PATH_FIELD } },
    handler: {
      apply: async ({ command }) => {
        const raw = command.payload?.path
        if (typeof raw !== 'string' || !raw.trim()) throw new CommandError('invalid', 'path is required')
        const abs = raw.trim()
        if (!isLocalPath(abs)) throw new CommandError('invalid', 'only local absolute paths are allowed')
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

  bus.registerDefinition<{ path: string }, { ok: true }>({
    type: 'file.delete',
    description: 'Delete a file, or a folder with everything inside it.',
    targetScheme: 'file',
    ignoreVersion: true,
    payloadSchema: { type: 'object', required: ['path'], properties: { path: PATH_FIELD } },
    handler: {
      apply: async ({ command }) => {
        const raw = command.payload?.path
        if (typeof raw !== 'string' || !raw.trim()) throw new CommandError('invalid', 'path is required')
        const abs = raw.trim()
        if (!isLocalPath(abs)) throw new CommandError('invalid', 'only local absolute paths are allowed')
        assertTargetMatches(command.target, abs)
        if (!fs.existsSync(abs)) throw new CommandError('not_found', 'Target does not exist')
        try {
          const stat = await fs.promises.stat(abs)
          if (stat.isDirectory()) await fs.promises.rm(abs, { recursive: true, force: true })
          else await fs.promises.unlink(abs)
          return { ok: true }
        } catch (err) {
          throw new CommandError('failed', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  bus.registerDefinition<{ path: string; to: string }, { ok: true }>({
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
      apply: async ({ command }) => {
        const raw = command.payload?.path
        const rawTo = command.payload?.to
        if (typeof raw !== 'string' || !raw.trim()) throw new CommandError('invalid', 'path is required')
        if (typeof rawTo !== 'string' || !rawTo.trim()) throw new CommandError('invalid', 'to is required')
        const source = raw.trim()
        const destination = rawTo.trim()
        if (!isLocalPath(source) || !isLocalPath(destination)) {
          throw new CommandError('invalid', 'only local absolute paths are allowed')
        }
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
