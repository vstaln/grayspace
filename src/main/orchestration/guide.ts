import * as fs from 'fs'
import * as os from 'os'
import { dirname, join } from 'path'
import { writeConfigAtomic } from '../atomicFile.ts'





const BEGIN = '<!-- BEGIN ORCSPACE (managed) -->'
const END = '<!-- END ORCSPACE (managed) -->'


const GUIDE_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const











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
    'orc worker-read backend                       # read its ordinary terminal answer',
    '```',
    '',
    'Names beat ids: rename a sibling once, then address it by name everywhere.',
    '`orc tell` does not create inbox mail. After a quick question sent with `tell`,',
    'read the answer with `orc worker-read <name>`. Use `orc check` only for messages',
    'sent through runs/tasks (`worker_done`, `ask`, `escalation`, and similar).',
    '',
    '**Good orchestration.** Before dispatching, turn the objective into a small, bounded',
    'task graph. Every task spec should state its goal, owned files or responsibility,',
    'acceptance criteria, verification command, and stop condition. Add dependencies',
    'only for real blockers; dispatch independent ready tasks in parallel, with no two',
    'workers owning the same files. The coordinator waits for reports, inspects the',
    'diff and test evidence, then releases or retains each dispatch — never treating',
    'a started process or a `tell` message as proof of completion.',
    '',
    'Use this compact task-spec shape when creating work:',
    '',
    '```text',
    'Goal: one concrete outcome',
    'Scope: files or responsibility owned by this worker',
    'Acceptance: observable conditions that must be true',
    'Verify: exact test/check to run',
    'Stop when: the acceptance criteria are met or a blocker is reported',
    '```',
    '',
    'Keep credentials, tokens, and private environment values out of task specs,',
    'mail, and reports. Use only agents currently available in the worker menu; do',
    'not invent a model or silently substitute an unavailable route.',
    '',
    '**Coordinating with other agents.** For work you intend to *wait on*, use runs,',
    'tasks and dispatches rather than `tell` — that is what gives you a completion',
    'report instead of a guess.',
    '',
    '```sh',
    'orc status                                   # what is running right now',
    'orc run-create --objective "..."             # open a run; check mail from this same terminal',
    'orc task-create --spec "..." [--deps \'["otask-1"]\']',
    'orc task-list --ready                        # what can be dispatched now',
    'orc task-show <id>                           # view full specification and status',
    'orc worker-start --task <id> --agent opencode  # opens a terminal and briefs it',
    'orc check --wait --types worker_done,escalation,ask,permission   # block until a worker reports',
    'orc reply <askId> "..."                      # unblock a worker that asked',
    'orc ask --type permission --question "..."     # request safety approval and wait',
    'orc allow <permission-id> [--note "..."]      # approve a permission request',
    'orc deny <permission-id> [--reason "..."]     # reject a permission request',
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
    '**Planner.** The day planner is the workspace task list.',
    'Use it to track work and report progress:',
    '',
    '```sh',
    'orc plan list                                # see all planner tasks',
    'orc plan create|update|toggle|delete [<id>]   # manage planner tasks',
    '```',
    '',
    '**The rest of the app** is the same CLI: `orc canvas`, `orc plan`,',
    '`orc terminal`, `orc git`, `orc journal`. Add `--json` for parseable',
    'output. Prefer putting results on the canvas or a task over loose files —',
    'the user is looking at the canvas, not at your scrollback.',
    END
  ].join('\n')
}






export function syncOrcGuide(dir: string): void {
  if (!dir) return
  purgeLegacyMcpConfigs(dir)
  const body = guideBody()
  const targets = GUIDE_FILES.map((name) => join(dir, name))

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






export function purgeLegacyMcpConfigs(dir?: string): void {

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

  }


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

      }
    }
  }
}





export function replaceManagedBlock(current: string, body: string): string {
  const start = current.indexOf(BEGIN)
  const end = current.indexOf(END)
  if (start >= 0 && end > start) {
    return current.slice(0, start) + body + current.slice(end + END.length)
  }
  if (!current.trim()) return `${body}\n`
  return `${current.trimEnd()}\n\n${body}\n`
}
