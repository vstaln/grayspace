import { CommandError } from '../core/index.ts'
import { commitAll, readGitStatus, type GitStatus } from '../git.ts'
import type { CommandDeps } from './index.ts'

/** The one resource every repository-wide operation contends for. */
export const GIT_TARGET = 'git:repo'

/**
 * Git, as coordination rather than as a client.
 *
 * The explicit non-goal is replacing a git GUI: there is no diff viewer and no
 * merge tool here, because that is a separate product. What the canvas needs
 * is status and a lock — an agent running `git commit` in a terminal has to
 * hold `git:repo`, or a second agent commits a half-finished tree underneath
 * it — and commits land in the journal so the assistant sees repository
 * history in the same stream as its own actions.
 */
export function registerGitCommands({ core, defaultCwd }: CommandDeps): {
  status(): Promise<GitStatus>
} {
  const { bus } = core
  let cached: GitStatus | null = null

  bus.registerDefinition<Record<string, never>, GitStatus>({
    type: 'git.refresh',
    description: 'Read the working tree status of the open project.',
    targetScheme: 'git',
    // Reading status contends with nothing; blocking it while an agent holds
    // the repo would hide exactly the state the user wants to watch.
    requiresLock: false,
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: async () => {
        cached = await readGitStatus(defaultCwd())
        return cached
      }
    }
  })

  bus.registerDefinition<{ message?: string }, { hash: string }>({
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
        try {
          const result = await commitAll(cwd, message)
          // The commit itself cannot be un-run once git accepted it; only the
          // post-commit status refresh is skippable.
          cached = await readGitStatus(cwd)
          return result
        } catch (err) {
          throw new CommandError('failed', String((err as { stderr?: string }).stderr || (err as Error).message))
        }
      }
    }
  })

  return {
    status: async (): Promise<GitStatus> => cached ?? (cached = await readGitStatus(defaultCwd()))
  }
}
