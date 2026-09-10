import { isSafeUrl, sanitizeUrl } from './sanitizeUrl.ts'

export type Provider = 'youtube' | 'yandex' | 'spotify' | 'audio'
export type Track = { id: string; url: string; title: string; provider: Provider }
export type Playlist = { id: string; name: string; tracks: Track[] }

export const SUPPORTED_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'weba'])

export function provider(url: string): Provider | null {
  try {
    const trimmed = url.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('orc://media/') || trimmed.startsWith('data:audio/') || trimmed.startsWith('blob:')) {
      return 'audio'
    }
    const u = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com' || host === 'music.youtube.com') return 'youtube'
    if (host === 'open.spotify.com' || host === 'spotify.com') return 'spotify'
    if (host === 'music.yandex.ru' || host === 'music.yandex.com') return 'yandex'
    const ext = u.pathname.split('.').pop()?.split('?')[0]?.toLowerCase() ?? ''
    if (SUPPORTED_AUDIO_EXTS.has(ext)) return 'audio'
  } catch {}
  return null
}

export function isSupportedAudioUrl(url: string): boolean {
  try {
    const trimmed = url.trim()
    if (trimmed.startsWith('orc://media/') || trimmed.startsWith('data:audio/') || trimmed.startsWith('blob:')) return true
    const u = new URL(url)
    const ext = u.pathname.split('.').pop()?.split('?')[0]?.toLowerCase() ?? ''
    return SUPPORTED_AUDIO_EXTS.has(ext)
  } catch {
    return false
  }
}

const DATA_URL_CAP = 2 * 1024 * 1024

export function sanitizeAudioSrc(url: string): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('orc://media/')) {
    return trimmed
  }
  if (trimmed.startsWith('orc://')) {
    return null
  }
  if (trimmed.startsWith('blob:')) {
    try {
      const inner = trimmed.slice(5)
      const u = new URL(inner)
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'orc:') return null
    } catch { return null }
    return trimmed
  }
  if (trimmed.startsWith('data:audio/')) {
    if (!/^data:audio\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return null
    if (trimmed.length > DATA_URL_CAP) return null
    return trimmed
  }
  if (trimmed.startsWith('data:')) return null
  const sanitized = sanitizeUrl(trimmed)
  if (!sanitized || !isSafeUrl(sanitized)) return null
  try {
    const u = new URL(sanitized)
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'orc:') return null
  } catch {
    return null
  }
  return sanitized
}

export function videoId(url: string): string | null {
  try {
    const trimmed = url.trim()
    const u = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`)
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.slice(1).split('/')[0]?.split('?')[0]
      return id && /^[\w-]{11}$/.test(id) ? id : null
    }
    const v = u.searchParams.get('v')
    if (v && /^[\w-]{11}$/.test(v)) return v
    const m = u.pathname.match(/\/(embed|v|shorts|live)\/([\w-]{11})/)
    if (m && m[2]) return m[2]
    const last = u.pathname.split('/').filter(Boolean).pop()?.split('?')[0]
    if (last && /^[\w-]{11}$/.test(last)) return last
    return null
  } catch {
    return null
  }
}


export function yandexEmbed(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host !== 'music.yandex.ru' && host !== 'music.yandex.com') return null
    const withAlbum = u.pathname.match(/\/album\/(\d+)\/track\/(\d+)/)
    if (withAlbum) return `https://music.yandex.ru/iframe/#track/${withAlbum[2]}/${withAlbum[1]}`
    const trackOnly = u.pathname.match(/\/track\/(\d+)/)
    if (trackOnly) return `https://music.yandex.ru/iframe/#track/${trackOnly[1]}`
  } catch {}
  return null
}


export function spotifyEmbed(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host !== 'open.spotify.com' && host !== 'spotify.com') return null
    const m = u.pathname.match(/\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/)
    if (m) return `https://open.spotify.com/embed/${m[1]}/${m[2]}`
  } catch {}
  return null
}

export function titleFor(kind: Provider, url: string): string {
  if (kind === 'audio') {
    try {
      const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'Audio track')
      return name.replace(/\.[a-z0-9]+$/i, '')
    } catch {
      return 'Audio track'
    }
  }
  return kind === 'youtube' ? 'YouTube track' : kind === 'spotify' ? 'Spotify track' : 'Yandex Music track'
}


export function coerceList(value: unknown): Playlist | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Playlist>
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  const tracks = Array.isArray(raw.tracks)
    ? raw.tracks.filter(
        (t): t is Track =>
          !!t &&
          typeof t === 'object' &&
          typeof t.id === 'string' &&
          typeof t.url === 'string' &&
          typeof t.title === 'string' &&
          (t.provider === 'youtube' || t.provider === 'yandex' || t.provider === 'spotify' || t.provider === 'audio')
      )
    : []
  return { id: raw.id, name: raw.name, tracks }
}

export const formatDuration = (value: number): string => {
  if (!Number.isFinite(value)) return '--:--'
  const n = Math.max(0, Math.floor(value))
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}
