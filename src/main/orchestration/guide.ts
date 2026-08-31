import * as fs from 'fs'
import * as os from 'os'
import { dirname, join } from 'path'
import { writeConfigAtomic } from '../atomicFile.ts'
import { safeParseJson, sanitizeParsed } from '../safeJson.ts'

/**
 * Markers around the block this app owns. Everything between them is rewritten
 * on every sync; everything outside is the user's and is never touched.
 */
const BEGIN = '<!-- BEGIN ORCSPACE (managed) -->'
const END = '<!-- END ORCSPACE (managed) -->'

/** The instruction files the major CLI agents read on startup, by convention. */
const GUIDE_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

/**
 * What an agent needs to know to coordinate, written where it will actually
 * read it.
 *
 * The CLI is discoverable in principle — it is on PATH and has `--help` — but
 * an agent only runs `--help` for a command it already believes exists. This
 * block is what makes it exist. Kept short on purpose: it competes for
 * attention with the user's own instructions, and a wall of flags would get
 * skimmed.
 */
function guideBody(): string {
  return [
    BEGIN,
    '## OrcSpace',
    '',
    'You are running inside OrcSpace, an infinite canvas the user is watching live.',
    'The `orc` command is already on your PATH and already authenticated — it talks',
    'to the running app directly. There is no MCP server to configure.',
    '',
    '**The other agents.** Every terminal on the canvas is addressable by its visible',
    'name, and you can act on any of them:',
    '',
    '```sh',
    'orc whoami                                   # your own agent id, terminal & task',
    'orc workers                                  # who else is open; * marks you',
    'orc rename --to term-3 --name backend        # give one a name that means something',
    'orc tell backend "run the tests and report"  # type into its terminal',
    '```',
    '',
    'Names beat ids: rename a sibling once, then address it by name everywhere.',
    '',
    '**Coordinating with other agents.** For work you intend to *wait on*, use runs,',
    'tasks and dispatches rather than `tell` — that is what gives you a completion',
    'report instead of a guess.',
    '',
    '```sh',
    'orc status                                   # what is running right now',
    'orc run-create --objective "..."             # open a run',
    'orc task-create --spec "..." [--deps \'["otask-1"]\']',
    'orc task-list --ready                        # what can be dispatched now',
    'orc task-show <id>                           # view full specification and status',
    'orc worker-start --task <id> --agent claude  # opens a terminal and briefs it',
    'orc check --wait --types worker_done,escalation,ask   # block until a worker reports',
    'orc reply <askId> "..."                      # unblock a worker that asked',
    'orc gates                                    # check open decision gates',
    'orc worker-release <dispatchId>              # account for a finished worker',
    '```',
    '',
    'If *you* were dispatched, your preamble named your task and dispatch ids. Report',
    'exactly once when you finish, success or failure — a coordinator is blocked on it:',
    '',
    '```sh',
    'orc done --outcome succeeded --task-id <t> --dispatch-id <d> --body "what changed"',
    'orc ask --question "..."     # blocks until the coordinator answers',
    'orc escalate --body "..."    # you are stuck and need intervention',
    '```',
    '',
    '**Planner & Kanban Tasks.** The day planner and kanban board are live and synced.',
    'You can pick tasks directly and report progress:',
    '',
    '```sh',
    'orc plan list                                # see all planner tasks',
    'orc board list                               # list kanban tasks',
    'orc board claim <id>                         # claim a task (moves to In Progress with your name)',
    'orc board update <id> done                   # complete a task (moves to Done and checks off in Planner)',
    '```',
    '',
    '**The rest of the app** is the same CLI: `orc canvas`, `orc brain`, `orc plan`,',
    '`orc board`, `orc terminal`, `orc git`, `orc journal`. Add `--json` for parseable',
    'output. Prefer putting results on the canvas (a note, a task) over loose files —',
    'the user is looking at the canvas, not at your scrollback.',
    END
  ].join('\n')
}

/**
 * Writes the managed block into every guide file that the workspace already
 * has, and creates `AGENTS.md` if it has none.
 *
 * Deliberately does not create both files: two instruction files saying the
 * same thing is noise in a repo the user has to live with, and every agent
 * worth supporting reads at least one of them.
 */
export function syncOrcGuide(dir: string): void {
  if (!dir) return
  purgeLegacyMcpConfigs(dir)
  const body = guideBody()
  const existing = GUIDE_FILES.map((name) => join(dir, name)).filter((file) => fs.existsSync(file))
  const targets = existing.length > 0 ? existing : [join(dir, GUIDE_FILES[0])]

  for (const file of targets) {
    try {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      const next = replaceManagedBlock(current, body)
      if (next !== current) writeConfigAtomic(file, next, dirname(file))
    } catch (err) {
      console.error(`could not write the OrcSpace guide into ${file}`, err)
    }
  }
}

/**
 * Removes obsolete orcspace MCP server configurations from global and project
 * configs (Codex, Claude, Cursor, Windsurf, OpenCode) so agents do not warn
 * about failed MCP handshakes on startup.
 */
export function purgeLegacyMcpConfigs(dir?: string): void {
  // 1. Clean Codex ~/.codex/config.toml
  try {
    const home = os.homedir()
    const codexConfig = join(home, '.codex', 'config.toml')
    if (fs.existsSync(codexConfig)) {
      const content = fs.readFileSync(codexConfig, 'utf8')
      if (content.includes('[mcp_servers.orcspace]')) {
        const cleaned = content.replace(/\[mcp_servers\.orcspace\][\s\S]*?(?=\n\[|$)/g, '').trimEnd() + '\n'
        writeConfigAtomic(codexConfig, cleaned, dirname(codexConfig))
      }
    }
  } catch {
    /* best effort */
  }

  // 2. Clean workspace .mcp.json and opencode.json
  if (dir) {
    for (const rel of ['.mcp.json', 'opencode.json', join('.cursor', 'mcp.json')]) {
      try {
        const p = join(dir, rel)
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8')
          const json = JSON.parse(raw)
          if (json.mcpServers && json.mcpServers.orcspace) {
            delete json.mcpServers.orcspace
            if (Object.keys(json.mcpServers).length === 0) {
              fs.unlinkSync(p)
            } else {
              writeConfigAtomic(p, JSON.stringify(json, null, 2) + '\n', dirname(p))
            }
          }
        }
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Swaps the managed block in place, or appends one. Anything the user wrote
 * around it survives untouched — this file is theirs, we are a guest in it.
 */
export function replaceManagedBlock(current: string, body: string): string {
  const start = current.indexOf(BEGIN)
  const end = current.indexOf(END)
  if (start >= 0 && end > start) {
    return current.slice(0, start) + body + current.slice(end + END.length)
  }
  if (!current.trim()) return `${body}\n`
  return `${current.trimEnd()}\n\n${body}\n`
}
