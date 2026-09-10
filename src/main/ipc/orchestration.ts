import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

export function registerOrchestrationIpc(deps: IpcDeps): void {
  const { orchestration, core } = deps
  const send = makeSend(core)

  ipcMain.handle('orchestration:snapshot', (_e, runId?: string) => {
    if (runId !== undefined && typeof runId !== 'string') return { error: 'runId must be a string' }
    return orchestration.snapshot(runId || undefined)
  })

  ipcMain.handle('orchestration:inbox', (_e, runId?: string) => {
    if (runId !== undefined && typeof runId !== 'string') return { error: 'runId must be a string' }
    return orchestration.listMessages({ runId: runId || undefined, limit: 200 })
  })

  ipcMain.handle('orchestration:reply', async (_e, askId: string, body: string) => {
    if (!askId || typeof askId !== 'string') return { error: 'askId is required' }
    const text = String(body ?? '')
    if (text.length > 1_048_576) return { error: 'reply body is too long' }
    const ask = orchestration.messageById(askId)
    if (!ask) return { error: `no message "${askId}"` }
    return unwrap(await send('orc.send', `run:${ask.runId}`, {
      type: 'reply', to: ask.from, replyTo: askId, subject: 'reply', body: text
    }))
  })

  ipcMain.handle('orchestration:permission', async (_e, askId: string, approved: boolean, note?: string) => {
    if (!askId || typeof askId !== 'string') return { error: 'askId is required' }
    const ask = orchestration.messageById(askId)
    if (!ask) return { error: `no message "${askId}"` }
    if (ask.type !== 'permission') return { error: `message "${askId}" is not a permission request` }
    const existing = orchestration.replyTo(askId)
    if (existing) return existing
    const detail = String(note ?? '').trim()
    return unwrap(await send('orc.send', `run:${ask.runId}`, {
      type: 'reply', to: ask.from, replyTo: askId,
      subject: approved === true ? 'permission_granted' : 'permission_denied',
      body: approved === true ? (detail ? `allow: ${detail}` : 'allow') : detail ? `deny: ${detail}` : 'deny'
    }))
  })

  ipcMain.handle('orchestration:resolve-gate', async (_e, gateId: string, resolution: string) => {
    if (!gateId || typeof gateId !== 'string') return { error: 'gateId is required' }
    const text = String(resolution ?? '')
    if (text.length > 10_000) return { error: 'resolution is too long' }
    return unwrap(await send('gate.resolve', `gate:${gateId}`, { resolution: text }))
  })

  ipcMain.handle('orchestration:account', async (_e, dispatchId: string, state: 'retained' | 'released', closeTerminal?: boolean) => {
    if (!dispatchId || typeof dispatchId !== 'string') return { error: 'dispatchId is required' }
    if (state !== 'retained' && state !== 'released') return { error: 'state must be retained|released' }
    return unwrap(await send('dispatch.account', `dispatch:${dispatchId}`, {
      state, closeTerminal: closeTerminal === true
    }))
  })

  ipcMain.handle('orchestration:close-run', async (_e, runId: string) => {
    if (!runId || typeof runId !== 'string') return { error: 'runId is required' }
    return unwrap(await send('run.close', `run:${runId}`))
  })
}
