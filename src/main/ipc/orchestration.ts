import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

/**
 * The window's view of the fleet.
 *
 * Agents drive orchestration through the `orc` CLI; this is the other half —
 * the human watching it happen, and stepping in where only a human can: answering
 * a worker's question, resolving a decision gate, releasing a terminal whose
 * worker is done. Those three are the operator's half of the contract, so they
 * are the writes exposed here. Everything else the UI does is a read.
 */
export function registerOrchestrationIpc(deps: IpcDeps): void {
  const { orchestration, core } = deps
  const send = makeSend(core)

  ipcMain.handle('orchestration:snapshot', (_e, runId?: string) => orchestration.snapshot(runId || undefined))

  ipcMain.handle('orchestration:inbox', (_e, runId?: string) =>
    // The human reads the coordinator's mail without consuming it: acking here
    // would silently steal a message an agent is about to act on.
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
