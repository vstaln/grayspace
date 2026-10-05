# Slate native runtime

Pure Rust: rgpui desktop app + PTY engine. No Tauri, no Electron, no UnoCSS.

## Binaries (`native/slate-app`)

- `slate` — the desktop window (terminal, planner, files, browser, orchestration) with an embedded control server on an IPC socket. No TCP port, by design.
- `slate --engine` — headless stdio JSON engine (spawn/write/resize/dispose over newline-delimited JSON).

## Commands

```text
npm run native:check
npm run native:run
npm run native:build
```

## Windows ConPTY

`npm install` fetches the ConPTY runtime package (`@homebridge/node-pty-prebuilt-multiarch`); build.rs copies `conpty.dll` + `OpenConsole.exe` from `node_modules` automatically. A standalone Rust build without npm sets `SLATE_CONPTY_DIR` to the directory holding them instead. Ship both files beside `slate.exe`. Unix PTYs are unchanged.

## Runtime boundary

The app owns terminal processes and serializes all input for each PTY through
one actor and one input mutex. `slate tell` sends one line plus carriage return
as one serialized operation, so a renderer keypress cannot split the message
from its submit key.
