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

const PORT = Number(process.env.WORKSPACE_CONTROL_PORT || 47932)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(
    `WORKSPACE_CONTROL_PORT должен быть номером порта 1–65535, получено: "${process.env.WORKSPACE_CONTROL_PORT}"`
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
  const file =
    process.env.ORCSPACE_CONTROL_TOKEN_FILE ||
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'orcspace', 'control-token')
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    return raw.length >= 32 ? raw : ''
  } catch {
    return ''
  }
}

async function api(pathname, init) {
  const token = controlToken()
  if (!token) throw new Error('control-token не найден — запустите OrcSpace хотя бы раз')
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
    console.error(`Не удалось получить статус координации: HTTP ${statusRes.status}: ${(await statusRes.text()).slice(0, 200)}`)
    process.exit(1)
  }
  let status
  try {
    status = await statusRes.json()
  } catch {
    console.error('Сервер управления вернул не-JSON ответ на /coordination/status.')
    process.exit(1)
  }

  if (!status.managerId) {
    console.log('Руководитель и так не назначен.')
  } else {
    // The manager itself is the only agent the API lets release the role, so we
    // release it *as* that agent — this script stands in for the human operator.
    const res = await api('/coordination/manager', {
      method: 'DELETE',
      body: JSON.stringify({ agentId: status.managerId })
    })
    if (!res.ok) {
      console.error('Не удалось сбросить руководителя:', await res.text())
      process.exit(1)
    }
    console.log(`Роль руководителя снята с «${status.managerId}».`)
  }

  if (wantLocks) {
    let locks = []
    try {
      const body = await (await api('/locks')).json()
      locks = Array.isArray(body.locks) ? body.locks : []
    } catch (err) {
      console.error('Не удалось получить список блокировок:', err.message)
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
    console.log(`Снято блокировок файлов: ${released} из ${locks.length}.`)
    if (failures.length > 0) {
      for (const failure of failures.slice(0, 10)) console.error(`Блокировка не снята: ${failure}`)
      process.exitCode = 1
    }
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})