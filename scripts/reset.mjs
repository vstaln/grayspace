#!/usr/bin/env node
/**
 * Drops the manager role and (optionally) all file locks in a running Workspace
 * app, for when an agent crashed while holding them. The same actions are
 * available from the left rail and the task board inside the app.
 *
 * Usage: node scripts/reset.mjs [--locks] [--all]
 */
const PORT = Number(process.env.WORKSPACE_CONTROL_PORT || 47932)
const BASE = `http://localhost:${PORT}`

const args = process.argv.slice(2)
const wantLocks = args.includes('--locks') || args.includes('--all')

async function main() {
  let status
  try {
    status = await (await fetch(`${BASE}/coordination/status`)).json()
  } catch {
    console.error(`Приложение Workspace не отвечает на ${BASE}. Запустите его и повторите.`)
    process.exit(1)
  }

  if (!status.managerId) {
    console.log('Руководитель и так не назначен.')
  } else {
    // The manager itself is the only agent the API lets release the role, so we
    // release it *as* that agent — this script stands in for the human operator.
    const res = await fetch(`${BASE}/coordination/manager`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: status.managerId })
    })
    if (!res.ok) {
      console.error('Не удалось сбросить руководителя:', await res.text())
      process.exit(1)
    }
    console.log(`Роль руководителя снята с «${status.managerId}».`)
  }

  if (wantLocks) {
    for (const lock of status.locks ?? []) {
      await fetch(`${BASE}/coordination/locks/${encodeURIComponent(lock.path)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: lock.agentId })
      })
    }
    console.log(`Снято блокировок файлов: ${status.locks?.length ?? 0}.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
