# OrcSpace — how the main process is put together

One rule holds the whole thing up:

> **Nobody writes to state directly. Every actor — the UI, the built-in
> assistant, every external agent — submits a command to one place.**

## The core (`src/main/core/`)

Electron-free and filesystem-free on purpose: the concurrency rules are run by
`node --test` with a fake clock, in a plain Node process.

| File | What it owns |
| --- | --- |
| `actors.ts` | Who may write. Every writer has an id and a type (`user`, `assistant`, `agent`, `system`). No anonymous writes. |
| `locks.ts` | Locks on **resources** (`file:…`, `note:…`, `terminal:…`, `git:repo`), each with a TTL and a heartbeat. Never persisted. |
| `journal.ts` | The append-only log. Every command is written as `intent` then `commit`/`abort`. |
| `bus.ts` | The single write path: identity → lock gate → version gate → apply → journal. |
| `versioned.ts` | The version bookkeeping the stores share. |

### What the bus guarantees

- **Sequential.** One command at a time; handlers never interleave.
- **No lost updates.** A stale `baseVersion` comes back as `conflict`, never a
  silent overwrite.
- **No unlocked writes.** A resource another actor holds is refused; a free one
  is locked implicitly for the duration of the apply.
- **Everything is journaled**, with the actor that did it.

## The stores

`canvasState.ts`, `brain.ts`, `coordination.ts`, `terminals.ts` hold the state
and none of the authority. Their mutating methods are called from exactly one
place: the handlers in `commands/`, which is also the complete list of things
that can happen to OrcSpace state.

The canvas merge deserves a note. The renderer owns the live layout while the
user drags, and echoes it back periodically. `importFromRenderer` merges
against a per-widget baseline, so a widget an agent moved in the meantime is
not undone by the window saving what it last read.

## Transports

`ipc.ts`, `controlServer.ts` and the MCP server authenticate an actor and
translate a request into a command. That is all they do — no lock checks, no
role rules, no store writes.

The control server requires `x-orcspace-token`, generated once per install and
stored `0600` in `userData`. Loopback is not authorisation: every process on
the machine is on loopback, and this API opens shells.

## The assistant (`src/main/assistant/`)

LangGraph's idea, none of its code: one typed `RunState` flowing through
plain-function nodes, a checkpoint after each, and a gate the graph parks at.

```
plan → acquire_lock → act → observe → reflect → human_gate
```

The journal is the checkpointer — a checkpoint is a `run.checkpoint` command,
so there is no second persistence system. The assistant is an ordinary actor:
it takes locks, skips busy resources rather than forcing them, replans on
conflict, and stops before anything destructive.

## Persistence

Per store, snapshot-based, each file carrying a `schemaVersion` with a
migration on load. **Locks are never written to disk** — every holder is dead
after a restart.

Terminals are Option A from the spec: `cwd` + title + capped scrollback (in its
own file, not the layout JSON). Reopening renders the saved screen as static
text and starts a fresh shell in the same directory. A `npm run dev` that was
running is gone, visibly.

## Tests

```
npm test        # node --test over src/main/**/*.test.ts
npm run typecheck
```

Covered: two actors at once, TTL expiry and heartbeats, lost updates, the lock
gate, command sequencing, journal intent/commit/abort, the assistant loop, the
human gate, crash recovery and idempotency.

## Not done yet

- The renderer still uses Tailwind; the canvas/WebGL rewrite (Part 5) has not
  started.
- No UI yet for assistant runs or the git-status widget — the main-process API
  and commands exist (`window.api.assistant`, `window.api.git`).
- State is still global in `userData` rather than scoped per project folder.
