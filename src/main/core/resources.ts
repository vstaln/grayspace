import { RESOURCE_SCHEMES, type ParsedResource, type ResourceId, type ResourceScheme } from './types.ts'

const SCHEMES = new Set<string>(RESOURCE_SCHEMES)

/**
 * Resource ids are `scheme:rest`, split on the *first* colon only — Windows
 * paths carry their own (`file:C:\src\index.ts`), and splitting greedily would
 * turn every absolute path on the primary platform into a malformed id.
 */
export function parseResource(target: ResourceId): ParsedResource | null {
  if (typeof target !== 'string') return null
  const at = target.indexOf(':')
  if (at <= 0) return null
  const scheme = target.slice(0, at)
  const id = target.slice(at + 1)
  if (!SCHEMES.has(scheme) || !id) return null
  return { scheme: scheme as ResourceScheme, id }
}

export function resourceId(scheme: ResourceScheme, id: string): ResourceId {
  return `${scheme}:${id}`
}

/**
 * File resources are normalised so two spellings of the same path cannot be
 * locked independently: backslashes become forward slashes and the drive
 * letter is upper-cased, because Windows is case-insensitive about it while a
 * `Map` key is not.
 */
export function fileResource(path: string): ResourceId {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = /^[a-z]:\//i.test(unified) ? unified[0].toUpperCase() + unified.slice(1) : unified
  return resourceId('file', normalized)
}

export function isResourceId(value: unknown): value is ResourceId {
  return typeof value === 'string' && parseResource(value) !== null
}
