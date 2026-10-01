import { useEffect, useRef } from 'react'

/**
 * Mirrors OrchestrationWidget's `pendingPermissions` derivation, but mounted
 * once at the app shell so "full permissions" works even when the
 * Orchestration widget isn't open on the canvas.
 */
export function useAutoApprovePermissions(enabled: boolean): void {
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  // Ids already sent to respondToPermission, so a snapshot refresh that
  // hasn't caught up with our own reply yet doesn't fire a second call.
  const claimedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let alive = true

    const check = async (): Promise<void> => {
      if (!enabledRef.current) return
      let snapshot
      try {
        snapshot = await window.api.orchestration.snapshot()
      } catch {
        return
      }
      if (!alive || !enabledRef.current) return
      const answered = new Set(snapshot.messages.filter((m) => m.type === 'reply').map((m) => m.replyTo))
      for (const message of snapshot.messages) {
        if (message.type !== 'permission') continue
        if (answered.has(message.id) || claimedRef.current.has(message.id)) continue
        claimedRef.current.add(message.id)
        void window.api.orchestration.respondToPermission(message.id, true, '').catch(() => {
          claimedRef.current.delete(message.id)
        })
      }
    }

    void check()
    const off = window.api.orchestration.onChange(() => void check())
    return () => {
      alive = false
      off()
    }
  }, [])
}
