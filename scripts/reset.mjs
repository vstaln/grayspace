#!/usr/bin/env node






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
const wantLocks = args.length === 0 || args.includes('--locks')

function controlToken() {
  const env = (process.env.ORCSPACE_CONTROL_TOKEN || '').trim()
  if (env) return env
  if (process.env.ORCSPACE_CONTROL_TOKEN_FILE) {
    try {
      const raw = fs.readFileSync(process.env.ORCSPACE_CONTROL_TOKEN_FILE, 'utf8').trim()
      if (raw.length >= 32) return raw
    } catch {

    }
  }



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
