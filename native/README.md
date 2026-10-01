# OrcSpace native runtime

This directory contains the pure-Rust engine and native desktop path. It
deliberately does not use Tauri or UnoCSS.

## Packages

- `orcspace-app` — native `eframe/egui` desktop application with Canvas and Code tabs.
- `orcspace-app --engine` — headless Rust PTY engine for the feature-complete
  Electron/React/xterm frontend. It uses newline-delimited JSON over stdio.
- `orcspace-app` also builds the `orc` binary for authenticated local control-server RPC.
- `canvas-core` and `storage-core` remain legacy N-API acceleration crates for
  the current Electron fallback and are excluded from the native workspace.

## Commands

```text
npm run native:check
npm run native:run
npm run native:build
```

On Windows, run `npm ci` before the first native build. The build copies the
Electron frontend's Windows 10 ConPTY runtime (`conpty.dll`, `OpenConsole.exe`)
beside the executable. Ship both files with `orcspace.exe`. A standalone Rust
build can instead set `ORCSPACE_CONPTY_DIR` to that runtime directory.
The local portable-pty patch resolves the bundled `Conpty*` exports and enables
VT passthrough, preserving synchronized cursor frames. Unix PTYs are unchanged.

On Windows the Rust toolchain must have a working linker. The current
environment can check this tree with `stable-x86_64-pc-windows-gnu`; the
default MSVC target requires Visual C++ Build Tools and `link.exe`.

`npm run dev` opens the feature-complete React/xterm UI. The stable Node PTY
backend is used by default. Set `ORCSPACE_RUST_ENGINE=1` to opt into the Rust
`--engine` sidecar when testing native terminal parity.

## Runtime boundary

The app owns terminal processes and serializes all input for each PTY through
one actor and one input mutex. `orc tell` sends one line plus carriage return
as one serialized operation, so a renderer keypress cannot split the message
from its submit key.
