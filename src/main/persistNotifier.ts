import { EventEmitter } from 'events'

export interface PersistError {
  store: string
  message: string
  at: number
}

const emitter = new EventEmitter()

export function notifyPersistError(store: string, error: unknown): void {
  const payload: PersistError = {
    store,
    message: error instanceof Error ? error.message : String(error),
    at: Date.now()
  }
  console.error(`[persist:${store}] failed to persist`, error)
  try {
    emitter.emit('persistError', payload)
  } catch (err) {
    // A throwing UI listener must not propagate back into the store write path.
    console.error('[persistError] listener threw', err)
  }
}

export function onPersistError(listener: (payload: PersistError) => void): () => void {
  emitter.on('persistError', listener)
  return () => emitter.off('persistError', listener)
}
