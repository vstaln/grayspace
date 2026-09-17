import type { RendererStateApi } from '../../../preload/api'

const INSTALL_KEY = Symbol.for('orcspace.durable-local-storage')

function durableKey(key: string): boolean {
  return key === 'workspace-theme' || key === 'rail-order' || /^orcspace(?::|-)/.test(key)
}

function currentValues(storage: Storage): Record<string, string> {
  const values: Record<string, string> = {}
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key || !durableKey(key)) continue
    const value = storage.getItem(key)
    if (value !== null) values[key] = value
  }
  return values
}

export async function installDurableLocalStorage(api: RendererStateApi): Promise<void> {
  const globalState = window as typeof window & { [INSTALL_KEY]?: boolean }
  if (globalState[INSTALL_KEY]) return

  const storage = window.localStorage
  const prototype = Storage.prototype
  const originalSet = prototype.setItem
  const originalRemove = prototype.removeItem
  const originalClear = prototype.clear

  try {
    const snapshot = await api.load()
    for (const [key, value] of Object.entries(snapshot.values)) {
      if (durableKey(key) && storage.getItem(key) === null) originalSet.call(storage, key, value)
    }
    await api.replace(currentValues(storage))
  } catch (error) {
    console.warn('failed to restore durable widget state', error)
  }

  prototype.setItem = function setItem(key: string, value: string): void {
    originalSet.call(this, key, value)
    if (this === storage && durableKey(String(key))) void api.set(String(key), String(value)).catch(() => undefined)
  }
  prototype.removeItem = function removeItem(key: string): void {
    originalRemove.call(this, key)
    if (this === storage && durableKey(String(key))) void api.remove(String(key)).catch(() => undefined)
  }
  prototype.clear = function clear(): void {
    originalClear.call(this)
    if (this === storage) void api.replace({}).catch(() => undefined)
  }
  globalState[INSTALL_KEY] = true
}
