import { CANVAS_TARGET_ID, type CanvasWidget, type WidgetKind } from '../canvasState.ts'
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

  bus.registerDefinition<WidgetCreatePayload, CanvasWidget>({
    type: 'widget.create',
    description: 'Create a canvas widget (note, terminal, timer, board, …).',
    targetScheme: 'widget',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '1–128 chars of [A-Za-z0-9._:-]; generated when omitted' },
        kind: { type: 'string', description: 'Widget kind from the registry' },
        title: { type: 'string' },
        noteId: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        z: { type: 'number' }
      }
    },
    handler: {
      apply: ({ command }) => {
        const p = command.payload ?? {}
        const id = (p.id || `${p.kind ?? 'widget'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).trim()
        if (!id || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) {
          throw new CommandError('invalid', 'widget id must be 1–128 chars of [A-Za-z0-9._:-]')
        }
        if (canvas.widget(id)) throw new CommandError('conflict', `widget ${id} already exists`)
        const defaults = widgetType(p.kind)?.defaultSize
        try {
          return canvas.putWidget({
            id,
            kind: p.kind,
            title: (p.title?.trim() || widgetType(p.kind)?.label || id).slice(0, 120),
            noteId: p.noteId,
            x: Number(p.x) || 0,
            y: Number(p.y) || 0,
            w: Number(p.w) || defaults?.w || 520,
            h: Number(p.h) || defaults?.h || 360,
            z: Number(p.z) || 1
          })
        } catch (err) {
          if (err instanceof CommandError) throw err
          throw new CommandError('invalid', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  bus.registerDefinition<WidgetPatchPayload, CanvasWidget>({
    type: 'widget.update',
    description: 'Move/resize/retitle a widget. Geometry is world-space; z orders the stack.',
    targetScheme: 'widget',
    payloadSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        noteId: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        z: { type: 'number' }
      }
    },
    handler: {
      apply: ({ command }) => {
        let id = widgetIdOf(command.target)
        // Models often say widget:new / terminal:new after opening a shell.
        // Only that sentinel retargets — a typo must not rename the focused pane.
        if (!canvas.widget(id) && id === 'new' && typeof command.payload?.title === 'string') {
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
    }
  })

  bus.registerDefinition<Record<string, never>, { id: string }>({
    type: 'widget.remove',
    description:
      'Remove a widget. Closing a terminal widget also tears down its shell.',
    targetScheme: 'widget',
    payloadSchema: { type: 'object', properties: {} },
    handler: {
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
    }
  })

  bus.registerDefinition<{ x: number; y: number; zoom: number }, { camera: unknown }>({
    type: 'canvas.camera',
    description: 'Set the viewer camera (world-space offset + zoom) for the main canvas.',
    targetScheme: 'canvas',
    requiresLock: false,
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Camera offset X' },
        y: { type: 'number', description: 'Camera offset Y' },
        zoom: { type: 'number', description: 'Zoom, 0.2–4' }
      }
    },
    handler: {
      apply: ({ command }) => ({ camera: canvas.setCamera(command.payload) })
    }
  })

  bus.registerDefinition<{ strokes: unknown }, { count: number }>({
    type: 'canvas.strokes',
    description: 'Replace the freehand stroke layer of the canvas.',
    targetScheme: 'canvas',
    payloadSchema: {
      type: 'object',
      properties: { strokes: { type: 'array', description: 'Stroke list as the renderer draws it' } }
    },
    handler: {
      apply: ({ command }) => ({ count: canvas.setStrokes(command.payload?.strokes).length })
    }
  })

  /**
   * The renderer's periodic layout save. It is a merge rather than a replace —
   * see `CanvasStore.importFromRenderer` — so a widget an agent created or
   * moved mid-drag is not undone by the UI echoing back what it last read.
   */
  bus.registerDefinition<
    { widgets?: unknown; camera?: unknown; strokes?: unknown; removed?: unknown },
    { applied: number; skipped: number; removed: number }
  >({
    type: 'canvas.import',
    description: 'Merge a renderer layout snapshot into the canvas store.',
    targetScheme: 'canvas',
    requiresLock: false,
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        widgets: { type: 'array', description: 'Widget geometry list' },
        camera: { type: 'object' },
        strokes: { type: 'array' },
        removed: { type: 'array' }
      }
    },
    handler: {
      apply: ({ command }) => {
        const result = canvas.importFromRenderer(command.payload ?? {})
        // A terminal widget the renderer no longer reports is gone from the
        // canvas for good: nothing will ever reclaim its pty, so tear the shell
        // down here exactly like widget.remove does. Otherwise the process keeps
        // running unseen until the app quits (CANV-01).
        for (const gone of result.removedWidgets) {
          if (gone.kind === 'terminal' || !gone.kind) {
            terminals.dispose(gone.id)
            snapshots.forget(gone.id)
            forgetOrigin(gone.id)
          }
        }
        return result
      }
    }
  })
}

/** The target every camera/stroke command addresses. */
export const CANVAS_TARGET = resourceId('canvas', CANVAS_TARGET_ID)
