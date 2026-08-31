<!-- BEGIN ORCSPACE (managed) -->
## OrcSpace

You are running inside OrcSpace, an infinite canvas the user is watching live.
The `orc` command is already on your PATH and already authenticated — it talks
to the running app directly. There is no MCP server to configure.

**The other agents.** Every terminal on the canvas is addressable by its visible
name, and you can act on any of them:

```sh
orc whoami                                   # your own agent id, terminal & task
orc workers                                  # who else is open; * marks you
orc rename --to term-3 --name backend        # give one a name that means something
orc tell backend "run the tests and report"  # type into its terminal
```

Names beat ids: rename a sibling once, then address it by name everywhere.

**Coordinating with other agents.** For work you intend to *wait on*, use runs,
tasks and dispatches rather than `tell` — that is what gives you a completion
report instead of a guess.

```sh
orc status                                   # what is running right now
orc run-create --objective "..."             # open a run
orc task-create --spec "..." [--deps '["otask-1"]']
orc task-list --ready                        # what can be dispatched now
orc task-show <id>                           # view full specification and status
orc worker-start --task <id> --agent claude  # opens a terminal and briefs it
orc check --wait --types worker_done,escalation,ask   # block until a worker reports
orc reply <askId> "..."                      # unblock a worker that asked
orc gates                                    # check open decision gates
orc worker-release <dispatchId>              # account for a finished worker
```

If *you* were dispatched, your preamble named your task and dispatch ids. Report
exactly once when you finish, success or failure — a coordinator is blocked on it:

```sh
orc done --outcome succeeded --task-id <t> --dispatch-id <d> --body "what changed"
orc ask --question "..."     # blocks until the coordinator answers
orc escalate --body "..."    # you are stuck and need intervention
```

**Planner & Kanban Tasks.** The day planner and kanban board are live and synced.
You can pick tasks directly and report progress:

```sh
orc plan list                                # see all planner tasks
orc board list                               # list kanban tasks
orc board claim <id>                         # claim a task (moves to In Progress with your name)
orc board update <id> done                   # complete a task (moves to Done and checks off in Planner)
```

**The rest of the app** is the same CLI: `orc canvas`, `orc brain`, `orc plan`,
`orc board`, `orc terminal`, `orc git`, `orc journal`. Add `--json` for parseable
output. Prefer putting results on the canvas (a note, a task) over loose files —
the user is looking at the canvas, not at your scrollback.
<!-- END ORCSPACE (managed) -->
