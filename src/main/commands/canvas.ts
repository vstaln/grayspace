import { CANVAS_TARGET_ID, type CanvasWidget, type WidgetKind } from '../canvasState'
import { CommandError, parseResource, resourceId } from '../core/index.ts'
import { widgetType } from '../widgets/registry.ts'
import type { CommandDeps } from './index.ts'

interface WidgetCreatePayload {
  id?: string
  kind?: WidgetKind
  title?: string
  noteId?: string
  x?: number
  y?: number
  w?: number
  h?: number
  z?: number
}

type WidgetPatchPayload = Partial<Omit<CanvasWidget, 'id' | 'version' | 'updatedAt'>>

/** The id part of a `widget:…` or `terminal:…` target (same bare id on canvas). */
function widgetIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || (parsed.scheme !== 'widget' && parsed.scheme !== 'terminal')) {
    throw new CommandError('invalid', `${target} is not a widget`)
  }
  return parsed.id
}

export function registerCanvasCommands({
  core,
  canvas,
  terminals,
  snapshots,
  forgetOrigin
}: CommandDeps): void {
  const { bus } = core

  bus.registerVersions('widget', canvas.widgetVersions)
  bus.registerVersions('canvas', canvas.canvasVersions)

  bus.register<WidgetCreatePayload, CanvasWidget>('widget.create', {
    ignoreVersion: true,
    apply: ({ command }) => {
      const p = command.payload ?? {}
      const id = (p.id || `${p.kind ?? 'widget'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).trim()
      if (canvas.widget(id)) throw new CommandError('conflict', `widget ${id} already exists`)
      const defaults = widgetType(p.kind)?.defaultSize
      return canvas.putWidget({
        id,
        kind: p.kind,
        title: p.title?.trim() || widgetType(p.kind)?.label || id,
        noteId: p.noteId,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        w: Number(p.w) || defaults?.w || 520,
        h: Number(p.h) || defaults?.h || 360,
        z: Number(p.z) || 1
      })
    }
  })

  bus.register<WidgetPatchPayload, CanvasWidget>('widget.update', {
    apply: ({ command }) => {
      let id = widgetIdOf(command.target)
      // "Rename it to Agent" after opening a shell: no valid widget id, but
      // there is an obvious preferred terminal on the canvas.
      if (!canvas.widget(id) && typeof command.payload?.title === 'string') {
        const preferred = terminals.resolveWriteTarget('')
        if (preferred && canvas.widget(preferred)) id = preferred
      }
      if (!canvas.widget(id)) throw new CommandError('not_found', `widget ${id} not found`)
      const updated = canvas.patchWidget(id, command.payload ?? {})
      // Keep the shell list label in the assistant's context in sync.
      if (typeof command.payload?.title === 'string' && (updated.kind === 'terminal' || !updated.kind)) {
        terminals.setTitle(id, command.payload.title)
      }
      return updated
    }
  })

  bus.register<Record<string, never>, { id: string }>('widget.remove', {
    apply: ({ command }) => {
      const id = widgetIdOf(command.target)
      // Closing a terminal widget must also tear the shell down: a live PTY
      // with no widget to reclaim it is a zombie process that keeps running
      // unseen. Mirror terminal.dispose's teardown so an agent's close_widget
      // cleans up everything (CANV-01).
      const widget = canvas.widget(id)
      if (widget && (widget.kind === 'terminal' || !widget.kind)) {
        terminals.dispose(id)
        snapshots.forget(id)
        forgetOrigin(id)
      }
      // Idempotent on purpose: this is the command most likely to be replayed
      // after a crash, and "it is already gone" is the outcome the caller
      // wanted either way.
      canvas.removeWidget(id)
      return { id }
    }
  })

  bus.register<{ x: number; y: number; zoom: number }, { camera: unknown }>('canvas.camera', {
    // The camera is per-viewer framing, not shared content: refusing to pan
    // because an agent holds a widget lock would be nonsense.
    requiresLock: false,
    ignoreVersion: true,
    apply: ({ command }) => ({ camera: canvas.setCamera(command.payload) })
  })

  bus.register<{ strokes: unknown }, { count: number }>('canvas.strokes', {
    apply: ({ command }) => ({ count: canvas.setStrokes(command.payload?.strokes).length })
  })

  /**
   * The renderer's periodic layout save. It is a merge rather than a replace —
   * see `CanvasStore.importFromRenderer` — so a widget an agent created or
   * moved mid-drag is not undone by the UI echoing back what it last read.
   */
  bus.register<
    { widgets?: unknown; camera?: unknown; strokes?: unknown; removed?: unknown },
    { applied: number; skipped: number }
  >('canvas.import', {
    requiresLock: false,
    ignoreVersion: true,
    apply: ({ command }) => canvas.importFromRenderer(command.payload ?? {})
  })
}

/** The target every camera/stroke command addresses. */
export const CANVAS_TARGET = resourceId('canvas', CANVAS_TARGET_ID)
