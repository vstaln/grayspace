import type { CanvasDelta } from '../../../preload/api'

/** Minimal structural shape: renderer Widget and main CanvasWidget both satisfy it. */
export interface VersionedWidget {
  id: string
  version?: number
}

export interface MergeContext {
  dirtyWidgetIds?: ReadonlySet<string>
  pendingCreates?: ReadonlySet<string>
  pendingDeletes?: ReadonlySet<string>
  suppressedWidgetIds?: ReadonlySet<string>
}

/**
 * Decides whether an incoming widget upsert should overwrite the local state.
 * - Preserves local widget if currently suppressed (e.g. user is actively dragging it).
 * - Preserves local widget if local version is >= incoming version.
 * - Preserves local unversioned widget if it has pending local modifications.
 */
export function shouldApplyUpsert(
  local: VersionedWidget | undefined,
  incoming: VersionedWidget,
  context: MergeContext = {}
): boolean {
  if (!local) return true

  if (context.suppressedWidgetIds?.has(local.id)) {
    return false
  }

  if (incoming.version !== undefined && (local.version ?? 0) >= incoming.version) {
    return false
  }

  if (
    local.version === undefined &&
    (context.dirtyWidgetIds?.has(local.id) || context.pendingCreates?.has(local.id))
  ) {
    return false
  }

  return true
}

/**
 * Pure helper applying a CanvasDelta to a widgets array.
 * Returns the updated widgets array or original reference if no change occurred.
 */
export function applyDeltaToWidgets<TWidget extends VersionedWidget>(
  prev: TWidget[],
  delta: CanvasDelta,
  context: MergeContext = {}
): TWidget[] {
  const { patch } = delta

  if (patch.op === 'upsert') {
    const incoming = patch.widget
    if (context.pendingDeletes?.has(incoming.id)) {
      return prev
    }

    const idx = prev.findIndex((w) => w.id === incoming.id)
    if (idx === -1) {
      if (context.suppressedWidgetIds?.has(incoming.id)) {
        return prev
      }
      return [...prev, incoming as unknown as TWidget]
    }

    const local = prev[idx]
    if (!shouldApplyUpsert(local, incoming, context)) {
      return prev
    }

    const next = [...prev]
    next[idx] = incoming as unknown as TWidget
    return next
  }

  if (patch.op === 'update') {
    const { id, changes } = patch
    if (context.pendingDeletes?.has(id) || context.suppressedWidgetIds?.has(id)) {
      return prev
    }
    const idx = prev.findIndex((w) => w.id === id)
    if (idx === -1) return prev

    const local = prev[idx]
    if (delta.version !== undefined && (local.version ?? 0) > delta.version) {
      return prev
    }
    if (
      local.version === undefined &&
      (context.dirtyWidgetIds?.has(id) || context.pendingCreates?.has(id))
    ) {
      return prev
    }

    const next = [...prev]
    next[idx] = { ...local, ...changes, version: delta.version ?? local.version } as TWidget
    return next
  }

  if (patch.op === 'remove') {
    const targetId = patch.id
    if (!prev.some((w) => w.id === targetId)) {
      return prev
    }
    return prev.filter((w) => w.id !== targetId)
  }

  if (patch.op === 'replace') {
    if (
      patch.value &&
      typeof patch.value === 'object' &&
      'widgets' in patch.value &&
      Array.isArray((patch.value as { widgets?: unknown }).widgets)
    ) {
      return (patch.value as unknown as { widgets: TWidget[] }).widgets
    }
    return prev
  }

  return prev
}
