#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mcpRoot = path.resolve(appRoot, '..', 'Orcspace-mcp')
const stagingParent = path.join(appRoot, '.staging')
const stagingRoot = path.join(stagingParent, 'mcp')
const tempRoot = path.join(stagingParent, `.mcp-stage-${process.pid}-${Date.now()}`)

function fail(message) {
  console.error(`[stage:mcp] ${message}`)
  process.exit(1)
}

function assertInside(base, target, label) {
  const relative = path.relative(path.resolve(base), path.resolve(target))
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return
  throw new Error(`[stage:mcp] ${label} escapes its allowed directory: ${target}`)
}

function removeTemp() {
  if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true })
}

assertInside(appRoot, stagingParent, 'staging parent')
assertInside(stagingParent, stagingRoot, 'staging root')
assertInside(stagingParent, tempRoot, 'temporary staging root')

const distSource = path.join(mcpRoot, 'dist')
const manifestSource = path.join(mcpRoot, 'package.json')
const lockfileSource = path.join(mcpRoot, 'package-lock.json')
if (!fs.existsSync(distSource)) fail(`MCP dist not found: ${distSource}`)
if (!fs.existsSync(manifestSource)) fail(`MCP package.json not found: ${manifestSource}`)
if (!fs.existsSync(lockfileSource)) fail(`MCP package-lock.json not found; npm ci requires a lockfile`)

try {
  // Build in a private sibling first. A failed npm ci therefore leaves the
  // previous complete staging tree intact and never creates a packable partial.
  removeTemp()
  fs.mkdirSync(tempRoot, { recursive: true })
  fs.cpSync(distSource, path.join(tempRoot, 'dist'), { recursive: true })
  fs.copyFileSync(manifestSource, path.join(tempRoot, 'package.json'))
  fs.copyFileSync(lockfileSource, path.join(tempRoot, 'package-lock.json'))

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['ci', '--omit=dev', '--no-fund', '--no-audit'], {
    cwd: tempRoot,
    stdio: 'inherit',
    // npm.cmd is a shell command on Windows. All arguments here are fixed
    // constants, so shell resolution does not introduce path interpolation.
    shell: process.platform === 'win32'
  })
  if (result.error) throw new Error(`could not run npm ci: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`npm ci exited with code ${result.status}`)

  // Swap only after the complete production install succeeds. Keep a backup
  // long enough to restore it if the second rename fails on Windows.
  const backupRoot = path.join(stagingParent, `.mcp-stage-backup-${process.pid}-${Date.now()}`)
  assertInside(stagingParent, backupRoot, 'backup staging root')
  let movedOld = false
  try {
    if (fs.existsSync(stagingRoot)) {
      fs.renameSync(stagingRoot, backupRoot)
      movedOld = true
    }
    fs.renameSync(tempRoot, stagingRoot)
  } catch (error) {
    // Only a failed swap rolls back. Cleanup of the old tree is best-effort
    // and must never run here: an EBUSY while deleting the backup would
    // otherwise destroy the freshly staged tree too.
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true })
    if (movedOld && fs.existsSync(backupRoot)) {
      try {
        fs.renameSync(backupRoot, stagingRoot)
      } catch (restoreError) {
        console.error(`[stage:mcp] could not restore the previous staging tree: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`)
      }
    }
    throw error
  }
  if (movedOld && fs.existsSync(backupRoot)) {
    try {
      fs.rmSync(backupRoot, { recursive: true, force: true })
    } catch (cleanupError) {
      console.warn(`[stage:mcp] kept the previous staging backup in place (${backupRoot}): ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`)
    }
  }
  console.log(`[stage:mcp] production dependencies staged in ${stagingRoot}`)
} catch (error) {
  removeTemp()
  console.error(`[stage:mcp] staging failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
