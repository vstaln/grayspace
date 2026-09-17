#!/usr/bin/env node
// Reclaims build artifacts. Preview by default: nothing is removed without
// --yes. The list of removable paths is closed and every entry is re-checked
// to live inside the repository before it is touched, so a typo or a stray
// argument cannot reach outside the project.
//
// This script never touches the user profile (.dev-user-data): settings,
// workspaces, the command journal and terminal scrollback live there.
// Clearing build output and resetting a profile are different operations and
// this one only does the first.

import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// path: repo-relative. why: what it is. rebuild: exact command that brings it
// back, or null when the artifact is genuinely gone for good.
const GROUPS = {
  'rust-cache': {
    title: 'Rust build caches',
    entries: [
      { path: 'native/target/debug', why: 'cargo debug cache for orcspace-app', rebuild: 'npm run native:run' },
      { path: 'native/target/x86_64-pc-windows-gnu', why: 'stale cross-compile target, not used by any script', rebuild: 'cargo build --target x86_64-pc-windows-gnu' },
      { path: 'native/canvas-core/target', why: 'napi build cache', rebuild: 'npm run build:native' },
      { path: 'native/storage-core/target', why: 'napi build cache', rebuild: 'npm run build:native' },
      // Both crates are gone from disk and were never tracked (see .gitignore),
      // so only cargo's cache is left. Nothing here is the last copy of
      // anything: verified to hold only build-script executables.
      { path: 'native/pty-core/target', why: 'cache of a removed crate', rebuild: 'n/a — crate no longer exists' },
      { path: 'native/brain-core/target', why: 'cache of a removed crate', rebuild: 'n/a — crate no longer exists' }
    ]
  },
  'electron-build': {
    title: 'Electron build output',
    entries: [
      { path: 'dist/win-unpacked', why: 'unpacked Windows build', rebuild: 'npm run dist' },
      { path: 'dist/security-check', why: 'intermediate release-security verification copy', rebuild: 'npm run dist' }
    ]
  },
  'old-installers': {
    title: 'Superseded installers (2.0.0)',
    entries: [
      { path: 'dist/OrcSpace-Setup-2.0.0-x64.exe', why: 'superseded by 2.0.1', rebuild: null },
      { path: 'dist/OrcSpace-Setup-2.0.0-x64.exe.blockmap', why: 'superseded by 2.0.1', rebuild: null },
      { path: 'dist/OrcSpace-Setup-2.0.0-x64.zip', why: 'superseded by 2.0.1', rebuild: null }
    ]
  },
  'test-results': {
    title: 'Playwright result directories from past runs',
    // test-results/ itself (the directory Playwright writes to) is deliberately
    // absent: it is the current run's output.
    entries: [
      'test-results-attachments', 'test-results-live-claude', 'test-results-matrix',
      'test-results-matrix-final', 'test-results-matrix-fixed', 'test-results-packaged',
      'test-results-release-2.0.1', 'test-results-review', 'test-results-zoom-final'
    ].map((path) => ({ path, why: 'output of an earlier Playwright run', rebuild: 'npm run test:e2e' }))
  }
}

// Nothing under these may ever be removed, whatever a group claims.
const PROTECTED = ['.git', '.dev-user-data', 'src', 'cli', 'e2e', 'scripts', 'assets', 'build', 'docs']

function insideRepo(absolute) {
  const rel = relative(ROOT, absolute)
  return rel !== '' && !rel.startsWith('..') && !resolve(rel).startsWith(sep)
}

function isProtected(repoRelative) {
  const first = repoRelative.split(/[\\/]/)[0]
  return PROTECTED.includes(first)
}

function sizeOf(target) {
  let total = 0
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()
    let stats
    try {
      stats = lstatSync(current)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue
    if (stats.isDirectory()) {
      let entries
      try {
        entries = readdirSync(current)
      } catch {
        continue
      }
      for (const entry of entries) stack.push(join(current, entry))
    } else {
      total += stats.size
    }
  }
  return total
}

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

const args = process.argv.slice(2)
const apply = args.includes('--yes')
const requested = args
  .filter((arg) => arg.startsWith('--group='))
  .map((arg) => arg.slice('--group='.length))

const unknown = requested.filter((name) => !(name in GROUPS))
if (unknown.length > 0) {
  console.error(`Unknown group(s): ${unknown.join(', ')}`)
  console.error(`Available: ${Object.keys(GROUPS).join(', ')}`)
  process.exit(2)
}

const selected = requested.length > 0 ? requested : Object.keys(GROUPS)

let grandTotal = 0
let removed = 0
const failures = []

for (const name of selected) {
  const group = GROUPS[name]
  console.log(`\n${group.title}  [--group=${name}]`)
  for (const entry of group.entries) {
    const absolute = resolve(ROOT, entry.path)

    if (!insideRepo(absolute)) {
      failures.push(`${entry.path}: resolves outside the repository — refused`)
      continue
    }
    if (isProtected(entry.path)) {
      failures.push(`${entry.path}: protected path — refused`)
      continue
    }
    if (!existsSync(absolute)) {
      console.log(`  -  ${entry.path.padEnd(46)} (absent)`)
      continue
    }
    if (lstatSync(absolute).isSymbolicLink()) {
      failures.push(`${entry.path}: is a symlink — refused`)
      continue
    }

    const bytes = sizeOf(absolute)
    grandTotal += bytes
    const restore = entry.rebuild ? `rebuild: ${entry.rebuild}` : 'NOT recoverable'
    console.log(`  ${apply ? 'x' : '?'}  ${entry.path.padEnd(46)} ${human(bytes).padStart(10)}   ${entry.why}; ${restore}`)

    if (apply) {
      try {
        rmSync(absolute, { recursive: true, force: true })
        removed += bytes
      } catch (error) {
        failures.push(`${entry.path}: ${error.message}`)
      }
    }
  }
}

console.log('')
if (apply) {
  console.log(`Freed ${human(removed)}.`)
} else {
  console.log(`Would free ${human(grandTotal)}. Nothing was removed.`)
  console.log('Re-run with --yes to delete, optionally narrowed with --group=<name>.')
}
for (const failure of failures) console.error(`  ! ${failure}`)
process.exitCode = failures.length > 0 ? 1 : 0
