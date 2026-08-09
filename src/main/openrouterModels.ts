const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_TTL_MS = 30 * 60_000
const FETCH_TIMEOUT_MS = 10_000

export interface CatalogModel {
  id: string
  label: string
  /** True when every price component is zero — OpenRouter's `:free` tier. */
  free: boolean
  contextLength: number
}

interface ApiModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
}

let cache: { at: number; models: CatalogModel[] } | null = null
let inflight: Promise<CatalogModel[]> | null = null

/**
 * The catalog OpenRouter actually serves right now, rather than a list baked
 * into the build that silently rots as models are retired and replaced. The
 * endpoint is public (no key needed), so this works before the user has pasted
 * one — the key is only required to *run* a completion.
 */
export async function fetchOpenRouterModels(force = false): Promise<CatalogModel[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models
  // Collapse concurrent callers (panel opening while a refresh is in flight)
  // onto one request instead of hitting the endpoint several times over.
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const res = await fetch(MODELS_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`)
      const body = (await res.json()) as { data?: unknown }
      const raw = Array.isArray(body.data) ? (body.data as ApiModel[]) : []
      const models = raw.map(toCatalogModel).filter((m): m is CatalogModel => m !== null)
      if (models.length === 0) throw new Error('OpenRouter returned an empty catalog')
      models.sort(byFreeThenName)
      cache = { at: Date.now(), models }
      return models
    } catch (err) {
      console.error('could not refresh the OpenRouter model catalog', err)
      // A stale list beats an empty picker; only a cold cache surfaces as [].
      return cache?.models ?? []
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function toCatalogModel(entry: ApiModel): CatalogModel | null {
  if (!entry || typeof entry.id !== 'string' || !entry.id) return null
  const label = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : entry.id
  const prompt = Number(entry.pricing?.prompt ?? 0)
  const completion = Number(entry.pricing?.completion ?? 0)
  return {
    id: entry.id,
    label,
    free: prompt === 0 && completion === 0,
    contextLength: Number(entry.context_length) || 0
  }
}

/** Free models first (they need no billing set up), then alphabetical. */
function byFreeThenName(a: CatalogModel, b: CatalogModel): number {
  if (a.free !== b.free) return a.free ? -1 : 1
  return a.label.localeCompare(b.label)
}
