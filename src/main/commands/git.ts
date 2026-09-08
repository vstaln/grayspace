import { CommandError } from '../core/index.ts'
import { commitAll, readGitStatus, type GitStatus } from '../git.ts'
import type { CommandDeps } from './index.ts'


export const GIT_TARGET = 'git:repo'











export function registerGitCommands({ core, defaultCwd }: CommandDeps): {
  status(): Promise<GitStatus>
} {
  const { flow } = core
  let cached: GitStatus | null = null
  let inflight: Promise<GitStatus> | null = null

  function isAbortError(err: unknown): boolean {
    const e = err as { name?: string; code?: string; message?: string }
    return e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || /aborted/i.test(String(e?.message ?? ''))
  }

  flow.registerDefinition<Record<string, never>, GitStatus>({
    type: 'git.refresh',
    description: 'Read the working tree status of the open project.',
    targetScheme: 'git',
    requiresLock: false,
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: async ({ signal }) => {
        if (signal?.aborted) throw new CommandError('cancelled', 'git status cancelled before it started')
        if (inflight) {
          try {
            const existing = await inflight
            if (signal?.aborted) throw new CommandError('cancelled', 'git status cancelled')
            return existing
          } catch (err) {
            if (isAbortError(err)) throw new CommandError('cancelled', 'git status cancelled')
            throw err
          }
        }
        const p = (async (): Promise<GitStatus> => {
          const cwd = defaultCwd()
          const res = await readGitStatus(cwd, signal)
          cached = res
          return res
        })()
        inflight = p
        try {
          return await p
        } catch (err) {
          if (isAbortError(err)) throw new CommandError('cancelled', 'git status cancelled')
          throw err
        } finally {
          if (inflight === p) inflight = null
        }
      }
    }
  })

  flow.registerDefinition<{ message?: string }, { hash: string }>({
    type: 'git.commit',
    description: 'Stage everything and create a commit on the open repository.',
    targetScheme: 'git',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      required: ['message'],
      properties: { message: { type: 'string', description: 'Commit message' } }
    },
    handler: {
      apply: async ({ command, signal }) => {
        const cwd = defaultCwd()
        if (!cwd) throw new CommandError('invalid', 'no project folder is open')
        if (signal?.aborted) throw new CommandError('cancelled', 'commit cancelled before it started')
        const message = String(command.payload?.message ?? '').trim()
        if (!message) throw new CommandError('invalid', 'a commit message is required')
        const normalizedMessage = message.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        try {
          const result = await commitAll(cwd, normalizedMessage, signal)
          if (signal?.aborted) return result
          try {
            cached = await readGitStatus(cwd, signal)
          } catch (err) {
            if (!isAbortError(err)) throw err
          }
          return result
        } catch (err) {
          if (isAbortError(err)) throw new CommandError('cancelled', String((err as Error).message || 'commit cancelled'))
          throw new CommandError('failed', String((err as { stderr?: string }).stderr || (err as Error).message))
        }
      }
    }
  })

  return {
    status: async (): Promise<GitStatus> => {
      if (cached) return cached
      if (inflight) return inflight
      const p = readGitStatus(defaultCwd())
      inflight = p
      try {
        cached = await p
        return cached
      } finally {
        if (inflight === p) inflight = null
      }
    }
  }
}
