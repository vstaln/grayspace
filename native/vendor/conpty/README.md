# Bundled Windows ConPTY runtime

Windows 10 ships `conpty.dll`, but the version bound to the OS cannot be
relied on across every supported build — so the app carries its own copy and
loads it from the directory beside the executable (see
`native/vendor/portable-pty/SLATE-PATCH.md` and `build.rs`).

Files (from Microsoft's own ConPTY release `1.22.250204002`, vendored so the
Rust build never needs npm or network access):

- `win10-x64/conpty.dll` + `OpenConsole.exe`
- `win10-arm64/conpty.dll` + `OpenConsole.exe`

`build.rs` reads them from `SLATE_CONPTY_DIR` when set, else from this
directory. Ship both files beside `slate.exe`. Unix builds ignore them.
