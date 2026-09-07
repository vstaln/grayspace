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

**Good orchestration.** Before dispatching, turn the objective into a small, bounded
task graph. Every task spec should state its goal, owned files or responsibility,
acceptance criteria, verification command, and stop condition. Add dependencies
only for real blockers; dispatch independent ready tasks in parallel, with no two
workers owning the same files. The coordinator waits for reports, inspects the
diff and test evidence, then releases or retains each dispatch — never treating
a started process or a `tell` message as proof of completion.

Use this compact task-spec shape when creating work:

```text
Goal: one concrete outcome
Scope: files or responsibility owned by this worker
Acceptance: observable conditions that must be true
Verify: exact test/check to run
Stop when: the acceptance criteria are met or a blocker is reported
```

Keep credentials, tokens, and private environment values out of task specs,
mail, and reports. Use only agents currently available in the worker menu; do
not invent a model or silently substitute an unavailable route.

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

**The rest of the app** is the same CLI: `orc canvas`, `orc plan`,
`orc board`, `orc terminal`, `orc git`, `orc journal`. Add `--json` for parseable
output. Prefer putting results on the canvas or a task over loose files —
the user is looking at the canvas, not at your scrollback.

**Ports, Networking & Build Invariants (MANDATORY FOR ALL AGENTS):**
- **Zero-Port Desktop IPC & Protocol Architecture:** The renderer loads via the custom secure scheme `orc://app/index.html` without requiring any local HTTP server. Communication with the `orc` CLI and local tooling uses in-memory Named Pipes (`\\.\pipe\orcspace` / `\\.\pipe\orcspace-dev`) on Windows and Unix Domain Sockets on macOS/Linux.
- **Strict Loopback Binding for TCP:** When TCP binding is requested (e.g. automated tests or `WORKSPACE_CONTROL_PORT`), the control server MUST always bind to `127.0.0.1` — NEVER bind to bare `localhost` or public hostnames (avoids Windows IPv6 `::1` DNS resolution delays and network leakage).
- **Default Isolation:**
  - Production / Installed app (`OrcSpace.exe`): zero TCP ports by default (pipe `\\.\pipe\orcspace`), user data in `%APPDATA%\OrcSpace`.
  - Dev mode (`dev.bat`): pipe `\\.\pipe\orcspace-dev`, user data in `.dev-user-data`, optional dev TCP port 20224.
- **Dynamic Free Port Fallback:** If a TCP port is requested and already occupied (e.g. `EADDRINUSE`), the app automatically binds to an available free port on `127.0.0.1` (`server.listen(0, '127.0.0.1')`) rather than crashing or terminating existing processes.
- **Auto-Discovery:** Active socket path and port are written to `runtime.json` (`socketPath`, `controlPort`). The `orc` CLI and client agents discover them automatically from `runtime.json`, environment (`ORCSPACE_SOCKET_PATH`, `ORCSPACE_URL`), or standard named pipes.
- **Coexistence:** Production and Dev mode can run simultaneously without conflicts, colliding sockets, or killing each other.
<!-- END ORCSPACE (managed) -->
