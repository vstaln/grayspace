# Migrating OrcSpace to Rust

Working document. Updated as steps land.

## Decision

OrcSpace moves to the native Rust app in `native/orcspace-app`. Electron stays
the shipping product until a Rust block has proven parity — it is never removed
on the strength of a plan. No third implementation is created: everything lands
in the existing `orcspace-app` crate.

## Strategy: back to front

The backend moves first, the UI last.

The codebase already contains the pattern: `src/main/rustPtySidecar.ts` runs
`orcspace --engine` as a child process, speaks JSON over stdio, and falls back
to `node-pty` when the binary is missing or misbehaves. Each further block
follows the same shape — Rust takes over a responsibility behind a fallback,
while Electron keeps running as the reference implementation you can diff
against on the same machine, with the same data, in the same session.

Why not UI first: an egui canvas with no state layer can only be demonstrated,
not verified. Moving state first means every step has a reference answer.

## Parity criteria

A block is done when its criterion is met with evidence, not when the code
compiles.

| # | Block | Parity criterion | Status |
|---|-------|------------------|--------|
| 0 | Journal hash chain | Rust recomputes every hash in a real `command-journal.ndjson` and matches the recorded value | **done** — 2244/2244 entries |
| 1 | State file readers | Rust parses every `workspace-canvas-*.json`, `workspace-code-*.json`, `workspace-board.json`, `orchestration.json` and re-serializes byte-identically | **done** — 88/88 documents |
| 2 | Projections | Folding the same journal in Rust and TypeScript yields identical canvas and planner snapshots | **done** — canvas on 2244 real entries, planner on a generated fixture |
| 3 | Command flow | Same command sequence produces the same journal entries, versions, lock decisions and error codes | **done** — speculative overlays (dry run) deliberately deferred |
| 4 | Control server + `orc` | All 13 route domains answer identically; all ~60 CLI commands produce identical `--json` output | **store done** — orchestration model ported and reading real files; routes and CLI outstanding |
| 5 | Terminals | Spawn, write, resize, dispose, scrollback persist, UTF-8 and ANSI correctness match; PTY children reaped on crash | partial — `engine.rs` runs under Electron on Windows |
| 6 | UI | Canvas, 9 widget kinds, CodeView at parity, measured against the stable-60 criterion | not started |
| 7 | Packaging | Installer, update channel, signing and notarization on Windows and macOS | not started |

Blocks 1–3 are strictly ordered. Block 4 depends on 3. Block 5 is independent
and already partly done. Block 6 depends on 1–4. Block 7 is last.

## Step 0 — what it proved (done)

The journal is hash-chained: each entry stores `sha256(JSON.stringify({...}))`
over the previous hash and its own fields. That makes it the one block with a
mechanical pass/fail, which is why it went first.

Two incompatibilities surfaced, both found by running rather than reading:

1. **Number formatting.** `serde_json` writes `1e21` where JavaScript writes
   `1e+21`, and `1e20` where JavaScript writes `100000000000000000000`. The
   canonical writer implements ECMAScript's `Number::toString` by hand.

2. **Float parsing — the one that mattered.** Against a real journal, Rust
   diverged at entry 169. `serde_json`'s default float parser read the canvas
   coordinate `3844.7897983016796` as the double one ULP above it, which then
   printed as `3844.78979830168`. A hand-written fixture would never have
   produced that value. Fixed by `serde_json`'s `float_roundtrip` feature.

The lesson generalises to every block below: **synthetic fixtures find format
bugs, real data finds precision bugs.** Each block needs both.

`preserve_order` and `float_roundtrip` on `serde_json` are load-bearing, not
preferences. Removing either silently corrupts state.

## Known blockers

**BrowserWidget cannot be reproduced in egui.** There is no web engine in the
stack, and adding one is a project of its own. This was raised before the path
was chosen and accepted. Options when block 6 arrives: drop the widget, shell
out to the system browser, or embed a separate engine. Decide then, not now.

**macOS is unverified.** Nothing has been run on a Mac. Ahead of block 7:

- the N-API addons ship only `index.win32-x64-msvc.node`; darwin-arm64 and
  darwin-x64 builds are needed or the app silently loses the accelerated paths
- the Rust engine is bundled only through `build.win.extraResources`; macOS has
  no equivalent entry, so `RustPtySidecar.create()` returns `null` there
- the Electron main bundle is compiled to V8 bytecode with a recorded
  `{platform, arch}`; a macOS build cannot be cross-produced from Windows
- notarization needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
  and a Developer ID certificate, and is skipped silently without them

## Performance target

Stable 60 fps and above — the criterion is the tail, not the mean. A run
alternating 8 ms and 25 ms frames averages over 60 and looks broken.
`src/renderer/src/lib/frameMetrics.ts` implements the verdict: mean at least
60, p99 within 1.25 budgets, at most 1% of frames missing their slot, at most
1% of vsync slots empty, no single frame over 50 ms.

The Electron baseline is not yet measured. It must be, before block 6: without
it there is no evidence that the Rust UI is an improvement rather than a
change. The existing e2e harness cannot produce it — it launches with
`--disable-gpu` and moves the window off-screen, where the compositor throttles
`requestAnimationFrame`.

## Working rules

- One block per branch, one reviewable change per step.
- Migration, deletion and optimisation never share a commit.
- Nothing in Electron is deleted until the replacing block has met its
  criterion with evidence recorded in this table.
- Rust builds run through PowerShell, not the Git Bash shell: GNU `link` from
  MSYS shadows MSVC's `link.exe` and the build fails with `link: extra operand`.

## Rollback

Every step is a commit on a branch off `main`; `main` itself is untouched.
`pre-migration-checkpoint` holds the state before any of this work began.

## Steps 1 and 2 — what they proved (done)

**Block 1.** 88/88 JSON documents in a real profile round-trip byte for byte.
The pretty writer had to match JavaScript's indented form, which differs from
its compact one by more than whitespace: a space after each colon, and empty
objects and arrays left as `{}` and `[]` instead of opened into blocks. State
documents are held as parsed JSON rather than mapped onto structs — typing them
would normalise away the historical shapes the block exists to detect.

**Block 2, canvas.** Folding a real 2244-entry journal produces the same 16
widgets, in the same order, with the same versions, camera, strokes and
connections as `CanvasStore.reduce`. The port is deliberately literal; three
behaviours that look incidental are load-bearing and now pinned by tests:
an unknown widget `kind` is rejected rather than defaulted, connections
de-duplicate by the `from`→`to` pair rather than by id, and orphaned
connections are pruned only in the branches that can orphan one.

`Date.now()` is injected rather than read. The TypeScript sanitizers fall back
to it for missing `updatedAt`/`bornAt`, which makes replay non-deterministic;
the fixtures pin it so a parity test compares like with like.

**Block 2, planner.** The `PlannerStore.reduce` port reproduces the fixture
item list. One divergence was only visible because the fixture ran the real
reducer: `order` is read differently by the two paths. `plan.create` uses
`Number(payload.order) || 0`, which coerces, so `order: "5"` stores 5;
`plan.update` uses `typeof === 'number' && Number.isFinite(...)`, which does
not, so the same payload leaves the previous value alone. Reading both strictly
passed every other case.

`plan.update` also normalises `day` with the *throwing* validator. A malformed
day aborts the fold rather than being ignored, so `reduce` returns a `Result`
instead of swallowing it — a replay must not quietly disagree with the live
store about which items exist.

**Correction to this plan.** Block 2 was written as covering orchestration too.
It does not: neither `OrchestrationStore` nor `CodeStore` folds the journal —
both are plain stores persisted to JSON, and block 1 already covers them by
round-tripping `orchestration.json` and `workspace-code-*.json`. Block 2 is
canvas and planner.

## Step 3 — what it proved (core done)

Locks, versions, resource ids, actors, payload validation, the idempotency
cache and the `apply` path are ported, each pinned against a fixture recorded
from the real TypeScript implementation.

The gate order is the part worth stating, because agents key on it: unknown
command, payload shape, malformed target, unknown actor, **lock**, **version**,
handler. A command that is both locked by someone else and carrying a stale
`baseVersion` reports `locked`, not `conflict` — the two call for different
responses from the caller, back off and retry versus re-read and rebase.

Other behaviours now pinned: an implicit lock is released whether the handler
succeeded or failed, so a failure never wedges a resource; a failing handler
appends an `abort` entry rather than leaving a dangling `intent`; a transient
command answers without journalling at all; and a `file:` target is normalised
*before* the lock is taken, so two spellings of one path contend for the same
lock instead of both appearing free.

Writing the lock fixture exposed a bug in the generator rather than in either
implementation: `LockManager` renews by mutating `expiresAt` in place, so
recording a result by reference captured the state at serialization time and
would have pinned expectations that were never true.

Admission control completes the block: the per-actor token bucket and the
queue's scheduling policy — priority bands, age promotion so a stream of
high-priority work cannot starve low work forever, lane exclusion, FIFO
tie-break. The limiter exempts `user` and `system` actors: it exists to bound a
runaway agent loop, not to throttle the person at the keyboard. A retry
carrying a known idempotency key is answered from the cache *before* the
limiter sees it, so a caller that behaved correctly after a dropped connection
is not charged for work that already happened.

Of `PriorityCommandQueue` only the decision is ported — which task runs next.
The surrounding machinery is promise-driven and specific to the JavaScript
runtime, while the policy is what determines observable ordering.

Deferred from block 3: the speculative overlay / dry-run path. It is a distinct
feature rather than an unfinished edge, and nothing in blocks 4-7 depends on
it. The bus runs commands synchronously — the TypeScript handlers are async
because they reach the filesystem through Electron, while the migrated stores
do their own I/O outside the bus.

## Step 4 — the orchestration store (in progress)

Most of `orc` is orchestration, so the store came before the routes. Runs,
tasks, dispatches, messages and gates are ported, and a real
`orchestration.json` loads: 5 runs, 8 tasks, 6 dispatches, with every task
pointing at a run that exists and every dispatch at a task that exists.

The invariants are the reason this block is not mechanical:

- a task is `ready` only when every dependency has **completed**, and settling
  a dispatch promotes what it unblocked *in the same operation* — a coordinator
  polling `task-list --ready` must never miss a promotion
- a task may have one running dispatch and a terminal may run one; both are
  refused as `conflict`, because two workers on one task is the failure this
  exists to prevent
- settling is one-way, so a duplicated `orc done` cannot flip an outcome
- a settled dispatch stays "unaccounted" until it is explicitly released or
  retained, which is what makes a coordinator account for finished work

Reading the real file corrected the port twice: runs are `run-N`, not
`orun-N`, and the id counter is **shared across every kind** — one sequence
produces `run-1`, `otask-2`, `disp-7`. Restarting it at zero on load would mint
ids that collide with existing records and overwrite them.

Outstanding in block 4: the 13 control-server route domains and the ~60 `orc`
commands on top of this store.
