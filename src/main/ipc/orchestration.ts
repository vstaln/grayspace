import { ipcMain } from './shims.ts'
import { NEW } from '../commands/index.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'










export function registerOrchestrationIpc(deps: IpcDeps): void {
  const { orchestration, core } = deps
  const send = makeSend(core)
  const missionResults = new Map<string, {
    runId: string
    taskId: string
    dispatchId: string
    terminalId: string
    agent: string
  }>()








  ipcMain.handle(
    'mission:start',
    async (
      _e,
      input: { objective?: string; title?: string; spec?: string; planId?: string; agent?: string; terminalId?: string }
    ) => {
      const objective = String(input?.objective ?? '').trim()
      const title = String(input?.title ?? '').trim()
      const spec = String(input?.spec ?? '').trim()
      const planId = String(input?.planId ?? '').trim()
      const agent = String(input?.agent ?? 'opencode').trim().toLowerCase() || 'opencode'
      const terminalId = String(input?.terminalId ?? '').trim()
      if (!objective || !title || !spec || !planId) return { error: 'mission objective, title, spec and planId are required' }
      const allowedAgents = new Set(['opencode', 'codex', 'claude', 'antigravity', 'grok'])
      if (!allowedAgents.has(agent)) return { error: `unsupported mission agent: ${agent}` }
      const commandByAgent: Record<string, string> = {
        opencode: 'opencode',
        codex: 'codex',
        claude: 'claude',
        antigravity: 'agy',
        grok: 'grok'
      }
      const previous = missionResults.get(planId)
      if (previous) return previous

      let runId = ''
      try {
        const run = unwrap(await send('run.create', NEW.run, { objective })) as { id: string }
        runId = run.id
        const task = unwrap(
          await send('orctask.create', NEW.orctask, {
            runId: run.id,
            title,
            spec: [
              `Planner item: ${planId}`,
              'The Planner item above is the single source of truth for this mission.',
              'Read the plan shown in OrcSpace Planner before editing.',
              '',
              spec
            ].join('\n')
          })
        ) as { id: string }
        const dispatch = unwrap(
          await send('dispatch.start', NEW.dispatch, {
            taskId: task.id,
            terminalId: terminalId || undefined,
            agent,
            command: commandByAgent[agent],
            inject: true
          })
        ) as {
          taskId: string
          dispatchId: string
          terminalId: string
          agent: string
        }
        const result = { runId: run.id, ...dispatch }
        missionResults.set(planId, result)
        return result
      } catch (error) {
        if (runId) {


          await send('run.close', `run:${runId}`, {}).catch(() => {})
        }
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('orchestration:snapshot', (_e, runId?: string) => orchestration.snapshot(runId || undefined))

  ipcMain.handle('orchestration:inbox', (_e, runId?: string) =>


    orchestration.listMessages({ runId: runId || undefined, limit: 200 })
  )

  ipcMain.handle('orchestration:reply', async (_e, askId: string, body: string) => {
    if (!askId || typeof askId !== 'string') return { error: 'askId is required' }
    const ask = orchestration.messageById(askId)
    if (!ask) return { error: `no message "${askId}"` }
    return unwrap(
      await send('orc.send', `run:${ask.runId}`, {
        type: 'reply',
        to: ask.from,
        replyTo: askId,
        subject: 'reply',
        body: String(body ?? '')
      })
    )
  })

  ipcMain.handle('orchestration:permission', async (_e, askId: string, approved: boolean, note?: string) => {
    if (!askId || typeof askId !== 'string') return { error: 'askId is required' }
    const ask = orchestration.messageById(askId)
    if (!ask) return { error: `no message "${askId}"` }
    if (ask.type !== 'permission') return { error: `message "${askId}" is not a permission request` }


    const existing = orchestration.replyTo(askId)
    if (existing) return existing

    const allowed = approved === true
    const detail = String(note ?? '').trim()
    return unwrap(
      await send('orc.send', `run:${ask.runId}`, {
        type: 'reply',
        to: ask.from,
        replyTo: askId,
        subject: allowed ? 'permission_granted' : 'permission_denied',
        body: allowed ? (detail ? `allow: ${detail}` : 'allow') : detail ? `deny: ${detail}` : 'deny'
      })
    )
  })

  ipcMain.handle('orchestration:resolve-gate', async (_e, gateId: string, resolution: string) => {
    if (!gateId || typeof gateId !== 'string') return { error: 'gateId is required' }
    return unwrap(await send('gate.resolve', `gate:${gateId}`, { resolution: String(resolution ?? '') }))
  })

  ipcMain.handle('orchestration:account', async (_e, dispatchId: string, state: 'retained' | 'released', closeTerminal?: boolean) => {
    if (!dispatchId || typeof dispatchId !== 'string') return { error: 'dispatchId is required' }
    return unwrap(
      await send('dispatch.account', `dispatch:${dispatchId}`, {
        state: state === 'retained' ? 'retained' : 'released',
        closeTerminal: closeTerminal === true
      })
    )
  })

  ipcMain.handle('orchestration:close-run', async (_e, runId: string) => {
    if (!runId || typeof runId !== 'string') return { error: 'runId is required' }
    return unwrap(await send('run.close', `run:${runId}`))
  })
}
