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
| 3 | Command flow | Same command sequence produces the same journal entries, versions, lock decisions and error codes | not started |
| 4 | Control server + `orc` | All 13 route domains answer identically; all ~60 CLI commands produce identical `--json` output | not started |
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
