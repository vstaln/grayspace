import { NEW } from '../commands/index.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

export function registerNotesIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('notes:list', () => deps.notes.list())
  ipcMain.handle(
    'notes:create',
    async (_e, input: { title: string; body?: string; tags?: string[]; category?: string; color?: string }) => {
      const title = typeof input?.title === 'string' ? input.title.trim() : ''
      if (!title) return { ok: false, error: 'title is required' }
      if (title.length > 200) return { ok: false, error: 'title is too long' }
      if (typeof input?.body === 'string' && input.body.length > 20_000) return { ok: false, error: 'body is too long' }
      const { body, tags, category, color } = input
      return unwrap(
        await send('note.create', NEW.note, {
          title,
          ...(typeof body === 'string' ? { body } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(typeof category === 'string' ? { category } : {}),
          ...(typeof color === 'string' ? { color } : {})
        })
      )
    }
  )
  ipcMain.handle(
    'notes:update',
    async (
      _e,
      id: string,
      patch: {
        title?: string
        body?: string
        tags?: string[]
        category?: string | null
        color?: string | null
        order?: number
        baseVersion?: number
      }
    ) => {
      if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
      return unwrap(await send('note.update', `note:${id}`, patch, patch?.baseVersion))
    }
  )
  ipcMain.handle('notes:recolorCategory', async (_e, category: string, color: string) => {
    if (!category || typeof category !== 'string') return { ok: false, error: 'category is required' }
    if (!color || typeof color !== 'string') return { ok: false, error: 'color is required' }
    return unwrap(await send('note.recolor', NEW.note, { category, color }))
  })
  ipcMain.handle('notes:delete', async (_e, id: string) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
    return unwrap(await send('note.delete', `note:${id}`))
  })
}
