# GraySpace 0.0.1

One native Rust binary. Five widgets: **terminal, planner, files, browser, orchestration**. No Electron, no Chromium, no Node in the binary — Node remains only for the `orc` CLI shim and these repo scripts.

- **Terminal** — `portable-pty` + `vt100`/`vte` engine; snapshots render in rgpui.
- **Browser** — vendored wry element. X11 renders inline in the window; Wayland opens a separate GTK window (accepted for 0.0.1).

## Build & run

```text
npm run native:build   # release binaries: grayspace + orc
npm run native:start   # release build, then open the GraySpace window
```

`npm run native:run` / `native:check` are the debug / check equivalents.

## Verify

```text
npm test                # version gate + Rust lib tests
node scripts/smoke.mjs  # spawn the release binary, check /health (needs a display)
```

## Layout

- `native/orcspace-app` — the app: `grayspace` GUI binary + `orc` control CLI
- `cli/orc.mjs` — compat CLI shim; talks to the control socket
- `scripts/` — `check-version`, `smoke`, `native-cargo` passthrough
- `docs/` — 0.0.1 plan + spec

Compat: `ORCSPACE_*` env, socket paths, the control-token file, and the `x-orcspace-token` header are unchanged, so `orc` drives the app without being told which implementation is running.
