#!/usr/bin/env node
/**
 * Drops the manager role and (optionally) all file locks in a running Workspace
 * app, for when an agent crashed while holding them. The same actions are
 * available from the left rail and the task board inside the app.
 *
 * Usage: node scripts/reset.mjs [--locks] [--all]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.WORKSPACE_CONTROL_PORT || 20220)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(
    `WORKSPACE_CONTROL_PORT must be a port number in 1-65535, got: "${process.env.WORKSPACE_CONTROL_PORT}"`
  )
  process.exit(1)
}
const BASE = `http://localhost:${PORT}`
const TOKEN_HEADER = 'x-orcspace-token'

const args = process.argv.slice(2)
const wantLocks = args.includes('--locks') || args.includes('--all')

function controlToken() {
  const env = (process.env.ORCSPACE_CONTROL_TOKEN || '').trim()
  if (env) return env
  if (process.env.ORCSPACE_CONTROL_TOKEN_FILE) {
    try {
      const raw = fs.readFileSync(process.env.ORCSPACE_CONTROL_TOKEN_FILE, 'utf8').trim()
      if (raw.length >= 32) return raw
    } catch {
      /* fall through to candidate probing */
    }
  }
  // Same candidate directories as cli/orc.mjs: the profile folder name varies
  // (OrcSpace/Orcspace/orcspace/com.orcspace.app) and probing only one casing
  // misses the token on case-sensitive filesystems (macOS/Linux).
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'OrcSpace', 'control-token') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Orcspace', 'control-token') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'orcspace', 'control-token') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'com.orcspace.app', 'control-token') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OrcSpace', 'control-token') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Orcspace', 'control-token') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'orcspace', 'control-token') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'com.orcspace.app', 'control-token') : null,
    path.join(os.homedir(), 'Library', 'Application Support', 'OrcSpace', 'control-token'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Orcspace', 'control-token'),
    path.join(os.homedir(), '.config', 'OrcSpace', 'control-token'),
    path.join(os.homedir(), '.config', 'Orcspace', 'control-token'),
    path.join(os.homedir(), '.config', 'orcspace', 'control-token'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'OrcSpace', 'control-token'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Orcspace', 'control-token'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'orcspace', 'control-token')
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim()
      if (raw.length >= 32) return raw
    } catch {
      /* try next candidate */
    }
  }
  return ''
}

async function api(pathname, init) {
  const token = controlToken()
  if (!token) throw new Error('control-token not found - run OrcSpace at least once')
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/json', ...(init?.headers || {}) }
  })
  return res
}

async function main() {
  // An HTML error page or a 500 must not surface as "Unexpected token < in JSON".
  const statusRes = await api('/coordination/status')
  if (!statusRes.ok) {
    console.error(`Could not read the coordination status: HTTP ${statusRes.status}: ${(await statusRes.text()).slice(0, 200)}`)
    process.exit(1)
  }
  let status
  try {
    status = await statusRes.json()
  } catch {
    console.error('The control server returned a non-JSON response for /coordination/status.')
    process.exit(1)
  }

  if (!status.managerId) {
    console.log('No manager is assigned.')
  } else {
    // The manager itself is the only agent the API lets release the role, so we
    // release it *as* that agent — this script stands in for the human operator.
    const res = await api('/coordination/manager', {
      method: 'DELETE',
      body: JSON.stringify({ agentId: status.managerId })
    })
    if (!res.ok) {
      console.error('Could not release the manager role:', await res.text())
      process.exit(1)
    }
    console.log(`Manager role released from "${status.managerId}".`)
  }

  if (wantLocks) {
    let locks = []
    try {
      const body = await (await api('/locks')).json()
      locks = Array.isArray(body.locks) ? body.locks : []
    } catch (err) {
      console.error('Could not list the locks:', err.message)
      process.exit(1)
    }
    let released = 0
    const failures = []
    for (const lock of locks) {
      const resource = lock.resource ?? lock.path
      const actorId = lock.actorId ?? lock.agentId
      if (!resource || !actorId) continue
      try {
        const res = await api(`/locks/${encodeURIComponent(resource)}`, {
          method: 'DELETE',
          body: JSON.stringify({ agentId: actorId })
        })
        if (res.ok) {
          released += 1
        } else {
          failures.push(`${resource}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
        }
      } catch (err) {
        failures.push(`${resource}: ${err.message || err}`)
      }
    }
    console.log(`File locks released: ${released} of ${locks.length}.`)
    if (failures.length > 0) {
      for (const failure of failures.slice(0, 10)) console.error(`Lock not released: ${failure}`)
      process.exitCode = 1
    }
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
