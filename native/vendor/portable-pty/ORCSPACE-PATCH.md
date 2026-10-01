Based on portable-pty 0.9.0 (MIT, see LICENSE.md).

The Windows loader resolves Microsoft's bundled `Conpty*` exports, loads
conpty.dll beside the application, and enables passthrough only for that
host. The system API remains the fallback for consumers without the bundle.
Unix code is unchanged. The app build stages the same Windows 10 ConPTY
distribution used by the Electron frontend.

Windows executable lookup preserves explicit extensions: `cmd.exe` cannot
resolve to an earlier `cmd.cmd` in PATH. Extensionless names still use
PATHEXT, ignoring malformed entries and directories.
