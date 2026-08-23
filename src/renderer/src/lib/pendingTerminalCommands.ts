/**
 * Commands waiting to be typed into a terminal the moment its shell finishes
 * spawning. Not component state and not persisted: a widget created and typed
 * into in the same gesture (the Code launcher) needs the command to survive
 * from "create the widget" to "the pty is actually ready" without threading a
 * prop through WidgetFrame's memoized tree for something used exactly once.
 */
const pending = new Map<string, string>()

export function queueInitialCommand(id: string, command: string): void {
  pending.set(id, command)
}

/** Removes and returns the queued command, so a remount can't retype it. */
export function takeInitialCommand(id: string): string | undefined {
  const command = pending.get(id)
  if (command !== undefined) pending.delete(id)
  return command
}
