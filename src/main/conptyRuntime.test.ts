import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const { ensureConptyRuntime, verifyConptyRuntime } = await import(new URL('../../scripts/conpty-runtime.mjs', import.meta.url).href)

test('restores the matching DLL/host pair from a distribution, including a partial installation', t => {
  const root = mkdtempSync(join(tmpdir(), 'orc-conpty-runtime-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'orc-conpty-runtime-'))
    rmSync(root, { recursive: true, force: true })
  })
  const packageDir = join(root, 'package')
  const bundled = join(root, 'distribution', 'Release')
  const target = join(packageDir, 'build', 'Release', 'conpty')
  mkdirSync(join(bundled, 'conpty'), { recursive: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(dirname(target), 'conpty.node'), 'existing addon')
  writeFileSync(join(target, 'conpty.dll'), 'stale DLL')
  writeFileSync(join(bundled, 'conpty', 'conpty.dll'), 'paired DLL')
  writeFileSync(join(bundled, 'conpty', 'OpenConsole.exe'), 'paired host')
  ensureConptyRuntime(packageDir, bundled, 'x64')
  assert.equal(readFileSync(join(target, 'conpty.dll'), 'utf8'), 'paired DLL')
  assert.equal(readFileSync(join(target, 'OpenConsole.exe'), 'utf8'), 'paired host')
  verifyConptyRuntime(target)
  // Idempotent even after the original distribution is no longer available.
  ensureConptyRuntime(packageDir, join(root, 'missing'), 'x64')
})

test('repopulates a cleaned build directory from the architecture-specific package runtime', t => {
  const root = mkdtempSync(join(tmpdir(), 'orc-conpty-runtime-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'orc-conpty-runtime-'))
    rmSync(root, { recursive: true, force: true })
  })
  for (const arch of ['x64', 'arm64']) {
    const source = join(root, 'third_party', 'conpty', '1.22', `win10-${arch}`)
    mkdirSync(source, { recursive: true })
    for (const file of ['conpty.dll', 'OpenConsole.exe']) writeFileSync(join(source, file), arch)
  }
  const target = join(root, 'build', 'Release', 'conpty')
  ensureConptyRuntime(root, undefined, 'arm64')
  assert.equal(readFileSync(join(target, 'conpty.dll'), 'utf8'), 'arm64')
  // Simulate node-gyp clearing its own output directory.
  rmSync(join(target, 'conpty.dll'))
  rmSync(join(target, 'OpenConsole.exe'))
  ensureConptyRuntime(root, undefined, 'arm64')
  verifyConptyRuntime(target)
})

test('build and installer reject a missing or incomplete runtime', t => {
  const root = mkdtempSync(join(tmpdir(), 'orc-conpty-runtime-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'orc-conpty-runtime-'))
    rmSync(root, { recursive: true, force: true })
  })
  assert.throws(() => ensureConptyRuntime(root, undefined, 'x64'), /No complete ConPTY runtime/)
  assert.throws(() => verifyConptyRuntime(root), /conpty\.dll.*OpenConsole\.exe/)
  writeFileSync(join(root, 'conpty.dll'), 'DLL')
  assert.throws(() => verifyConptyRuntime(root), /OpenConsole\.exe/)
})
