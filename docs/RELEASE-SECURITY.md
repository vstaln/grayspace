# Release protection

The main process is compiled to V8 bytecode inside an Electron main process. The
compiler and loader use `vm.compileFunction`; Electron 42+ has a different V8
snapshot in Node mode, so the electron-vite 3 Node-mode compiler is incompatible.
An explicit source-length prefix avoids treating V8's internal flags as a length.
The existing plugin still transforms arrow functions before compilation.

Preload and renderer stay minified JavaScript; preload keeps its sandbox.
Production main-window DevTools are disabled. ASAR is an archive, not encryption.
Bytecode raises the cost of reverse engineering; strings, renderer code, the CLI
and native binaries remain inspectable. Never embed service secrets in a client.

The afterPack hook rejects source maps, development files, private-key files,
extra plaintext main bundles and bytecode from another OS/architecture. It enables
ASAR integrity and ASAR-only loading, and disables NODE_OPTIONS and Node inspector
arguments before signing. RunAsNode remains enabled because the CLI needs it.
Fuses do not prevent a machine owner from patching an unsigned executable.

Build on the target OS and architecture with the installed Electron version.
For macOS, build arm64 and x64 separately on matching hosts/runtimes. Sign Windows
releases and sign/notarize macOS releases using your release credentials; none
are added by these changes. Unsigned local builds are for verification.

Source-tree archives and `.command` installers are not distribution artifacts and
are no longer generated. Use the binary installer paths instead.

Checks: `npm run typecheck:node`, `node --test scripts/release-security.test.cjs`,
`npx electron-vite build`, then the startup E2E test and electron-builder packaging.
