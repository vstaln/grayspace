# OrcSpace — building on macOS

This archive holds the complete source needed to build OrcSpace for macOS.
It contains no `node_modules`, no build caches, and no Windows binaries — those
are downloaded or rebuilt on your Mac, which is why it is small.

**Why source and not a ready `.dmg`:** a macOS `.app` bundle can only be built
on macOS. `electron-builder` refuses the job anywhere else — the bundle needs
symlinks and a case-sensitive filesystem layout that Windows does not provide.
There is no cross-build workaround, so the build has to happen on the Mac.

---

## Quick start

1. Unzip this archive anywhere (Desktop is fine).
2. Open the folder in Finder.
3. Double-click **`build-mac.command`**.

If macOS refuses to run it ("cannot be opened because it is from an
unidentified developer"), open Terminal in the folder and run:

```bash
chmod +x build-mac.command
./build-mac.command
```

The script checks your environment, installs dependencies and builds. The first
run takes roughly 5–15 minutes, mostly `npm install`. Later runs are much
faster.

The finished app lands in **`dist/`**.

---

## Requirements

The script verifies all of these and stops with a clear message if one is
missing.

| Requirement | Install |
|---|---|
| macOS | — |
| Node.js 20 or newer | `brew install node` (or nodejs.org) |
| Xcode Command Line Tools | `xcode-select --install` |
| Rust *(optional)* | `brew install rust` |

**Xcode Command Line Tools are not optional.** `node-pty` (the real shells) and
the native crates compile from source; without the tools `npm install` dies
midway with an opaque linker error.

**Rust is optional.** It builds three small native accelerators. Without it the
app uses TypeScript fallbacks and works fine — you just miss a small speedup.

> **On Apple Silicon:** make sure Node is the arm64 build, not x64 under
> Rosetta. The script warns you if it detects this. A mismatch compiles x64
> bindings against an arm64 Electron, and the app fails at launch with
> *"mach-o file, but is an incompatible architecture"*. Fix:
> `arch -arm64 brew install node`

---

## Build options

| Command | Output | Size |
|---|---|---|
| `./build-mac.command` | `.zip` for **this Mac's** architecture | **~100 MB** |
| `./build-mac.command --dmg` | `.dmg` disk image | ~110 MB |
| `./build-mac.command --all` | Apple Silicon + Intel, `.dmg` + `.zip` | ~400 MB |

The default is the lightest: only your own architecture, no disk-image
packaging. Use `--all` only when you need to hand the app to someone whose Mac
may be Intel.

Direct npm equivalents, if you prefer:

```bash
npm run dist:mac:arm     # Apple Silicon .zip
npm run dist:mac:intel   # Intel .zip
npm run dist:mac         # everything (both arches, .dmg + .zip)
```

---

## Installing the result

1. Unzip (or open the `.dmg`) and drag **OrcSpace.app** to `/Applications`.
2. Remove the quarantine flag:

```bash
xattr -cr /Applications/OrcSpace.app
```

3. Launch it normally.

### About step 2

**The build is unsigned.** Signing needs an Apple Developer ID certificate
($99/year), and there is none here. Without it macOS Gatekeeper reports the app
as *"damaged and can't be opened"*.

The app is not damaged. That message is what Gatekeeper always says about an
unsigned app; `xattr -cr` strips the quarantine attribute macOS attaches to
downloaded files and lets it run.

This is fine for your own machine. **For distributing to other people you need
real signing and notarization** — otherwise every one of them has to run that
command, and most will not. The build config is already prepared for it
(`hardenedRuntime`, `build/entitlements.mac.plist`); it only needs the
certificate.

---

## Running from source, without building

To develop rather than package:

```bash
./setup.command    # installs everything and starts the app
```

or:

```bash
npm install
npm run dev
```

---

## What is in the archive

```
src/              app source (main, preload, renderer)
Orcspace-mcp/     the MCP server, embedded into the app at build time
native/           three optional Rust crates (sources only)
assets/icons/     app icon
build/            macOS entitlements
scripts/          setup and maintenance scripts
e2e/              Playwright end-to-end tests
build-mac.command the build script
setup.command     dev setup / launch script
```

Excluded on purpose, all regenerated locally: `node_modules/`, `dist/`, `out/`,
`native/*/target/` (Rust cache, ~360 MB) and the compiled `.node` binaries,
which are Windows-only and get rebuilt for macOS.

---

## Verifying the build

```bash
npm run typecheck   # TypeScript, main + renderer
npm test            # 261 unit tests
npm run test:e2e    # 15 Playwright tests against a real Electron build
```

All three pass on the code in this archive.

---

## Troubleshooting

**`npm ci` fails with a linker error** — Command Line Tools are missing:
`xcode-select --install`

**App will not launch, "incompatible architecture"** — Node is x64 under Rosetta
on Apple Silicon. Reinstall as arm64 (`arch -arm64 brew install node`), delete
`node_modules`, run the script again.

**"OrcSpace is damaged"** — expected for an unsigned build; see step 2 above.

**Build succeeds but `dist/` is empty** — check the log the script prints. The
usual cause is `npm ci` having failed earlier while the build continued.

**Terminals do not open in the app** — `node-pty` did not compile. Delete
`node_modules`, confirm Command Line Tools are installed, and rerun.
