import { CANVAS_TARGET_ID, type CanvasCamera, type CanvasWidget, type WidgetKind } from '../canvasState.ts'
import { CommandError, parseResource, resourceId } from '../core/index.ts'
import { widgetType } from '../widgets/registry.ts'
import type { CommandDeps } from './index.ts'
import { failTerminalDispatches } from './orchestration.ts'

export const CANVAS_TARGET = resourceId('canvas', CANVAS_TARGET_ID)

interface WidgetCreatePayload {
  id?: string
  kind?: WidgetKind
  title?: string
  x?: number
  y?: number
  w?: number
  h?: number
  z?: number
}

type WidgetPatchPayload = Partial<Omit<CanvasWidget, 'id' | 'version' | 'updatedAt'>>


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
  orchestration,
  forgetOrigin,
  requestWidget,
  requestWidgetRename,
  requestWidgetRemoval
}: CommandDeps): void {
  const { flow } = core

  flow.registerVersions('widget', canvas.widgetVersions)
  flow.registerVersions('canvas', canvas.canvasVersions)

  flow.registerDefinition<WidgetCreatePayload, CanvasWidget>({
    type: 'widget.create',
    description: 'Create a canvas widget (terminal, timer, planner, …).',
    targetScheme: 'widget',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '1–128 chars of [A-Za-z0-9._:-]; generated when omitted' },
        kind: { type: 'string', description: 'Widget kind from the registry' },
        title: { type: 'string' },
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
          const widget = canvas.putWidget({
            id,
            kind: p.kind,
            title: (p.title?.trim() || widgetType(p.kind)?.label || id).slice(0, 120),
            x: Number(p.x) || 0,
            y: Number(p.y) || 0,
            w: Number(p.w) || defaults?.w || 520,
            h: Number(p.h) || defaults?.h || 360,
            z: Number(p.z) || 1
          })


          requestWidget({
            id: widget.id,
            title: widget.title,
            kind: widget.kind,
            x: widget.x,
            y: widget.y,
          })
          return widget
        } catch (err) {
          if (err instanceof CommandError) throw err
          throw new CommandError('invalid', err instanceof Error ? err.message : String(err))
        }
      }
    }
  })

  flow.registerDefinition<WidgetPatchPayload, CanvasWidget>({
    type: 'widget.update',
    description: 'Move/resize/retitle a widget. Geometry is world-space; z orders the stack.',
    targetScheme: 'widget',
    payloadSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
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


        if (!canvas.widget(id) && id === 'new' && typeof command.payload?.title === 'string') {
          const preferred = terminals.resolveWriteTarget('')
          if (preferred && canvas.widget(preferred)) id = preferred
        }
        if (!canvas.widget(id)) throw new CommandError('not_found', `widget ${id} not found`)
        const rawTitle = command.payload?.title
        const cleanTitle = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 200) : undefined
        const payload = { ...(command.payload ?? {}) }
        if (cleanTitle) payload.title = cleanTitle
        else delete payload.title
        const updated = canvas.patchWidget(id, payload)

        if (cleanTitle) {
          if (updated.kind === 'terminal' || !updated.kind) {
            terminals.setTitle(id, cleanTitle)
          }
          requestWidgetRename?.(id, cleanTitle)
        }
        return updated
      }
    }
  })

  flow.registerDefinition<Record<string, never>, { id: string }>({
    type: 'widget.remove',
    description:
      'Remove a widget. Closing a terminal widget also tears down its shell.',
    targetScheme: 'widget',
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => {
        const id = widgetIdOf(command.target)
        const removed = canvas.removeWidget(id)
        if (!removed) throw new CommandError('not_found', `widget ${id} not found`)
        forgetOrigin(id)
        requestWidgetRemoval(id)
        snapshots.forget(id)
        if (terminals.has(id)) {
          terminals.dispose(id)
        }
        failTerminalDispatches({ orchestration }, id)
        return { id }
      }
    }
  })

  flow.registerDefinition<{ x?: number; y?: number; zoom?: number }, { camera: CanvasCamera }>({
    type: 'canvas.camera',
    description: 'Pan or zoom the canvas viewport (world coordinates).',
    targetScheme: 'canvas',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        zoom: { type: 'number' }
      }
    },
    handler: {
      apply: ({ command }) => {
        const parsed = parseResource(command.target)
        if (!parsed || parsed.scheme !== 'canvas') {
          throw new CommandError('invalid', 'canvas.camera target must have canvas scheme')
        }
        return { camera: canvas.setCamera(command.payload ?? {}) }
      }
    }
  })

  flow.registerDefinition<{ strokes: unknown }, { count: number }>({
    type: 'canvas.strokes',
    description: 'Update freehand strokes on the canvas.',
    targetScheme: 'canvas',
    payloadSchema: {
      type: 'object',
      properties: {
        strokes: { type: 'array' }
      }
    },
    handler: {
      apply: ({ command }) => {
        return { count: canvas.setStrokes(command.payload?.strokes).length }
      }
    }
  })

  flow.registerDefinition<{ connections: unknown }, { count: number }>({
    type: 'canvas.connections',
    description: 'Update the arcs drawn between widgets on the canvas.',
    targetScheme: 'canvas',
    payloadSchema: {
      type: 'object',
      properties: {
        connections: { type: 'array' }
      }
    },
    handler: {
      apply: ({ command }) => {
        return { count: canvas.setConnections(command.payload?.connections).length }
      }
    }
  })

  flow.registerDefinition<
    { widgets?: unknown; camera?: unknown; strokes?: unknown; connections?: unknown },
    { applied: number; skipped: number; removed: number; removedWidgets: Array<{ id: string; kind?: WidgetKind }> }
  >({
    type: 'canvas.import',
    description: 'Merge an entire canvas snapshot from the renderer.',
    targetScheme: 'canvas',
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => {
        return canvas.importFromRenderer(command.payload ?? {})
      }
    }
  })
}
