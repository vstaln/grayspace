import React, { useEffect, useRef, useState } from 'react'
import { ExternalLink, Music2, Pause, Play, Plus, RotateCcw, SkipBack, SkipForward, SquareStop, Trash2, Volume2, VolumeX } from 'lucide-react'
import { isSafeUrl, sanitizeUrl } from '../lib/sanitizeUrl'

type Provider = 'youtube' | 'yandex' | 'spotify' | 'audio'
type Track = { id: string; url: string; title: string; provider: Provider }
type Playlist = { id: string; name: string; tracks: Track[] }
type Player = {
  destroy(): void
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(volume: number): void
  mute(): void
  unMute(): void
  getCurrentTime(): number
  getDuration(): number
  getVideoData?(): { title?: string; author?: string; video_id?: string }
}
type YTApi = {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string
      playerVars?: Record<string, unknown>
      events?: {
        onReady?: () => void
        onStateChange?: (e: { data: number }) => void
        onError?: (e: { data: number }) => void
      }
    }
  ) => Player
  PlayerState: {
    UNSTARTED: number
    ENDED: number
    PLAYING: number
    PAUSED: number
    BUFFERING: number
    CUED: number
  }
}

declare global {
  interface Window {
    YT?: YTApi
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YTApi> | null = null

function youtubeApi(): Promise<YTApi> {
  if (typeof window !== 'undefined' && window.YT?.Player) {
    return Promise.resolve(window.YT)
  }
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (window.YT?.Player) {
          resolve(window.YT)
        } else {
          apiPromise = null
          reject(new Error('YouTube API timed out'))
        }
      }, 10000)

      const prevHandler = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timeout)
        if (typeof prevHandler === 'function') {
          try {
            prevHandler()
          } catch {}
        }
        if (window.YT?.Player) {
          resolve(window.YT)
        } else {
          apiPromise = null
          reject(new Error('YouTube API unavailable'))
        }
      }

      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const script = document.createElement('script')
        script.src = 'https://www.youtube.com/iframe_api'
        script.async = true
        script.onerror = () => {
          clearTimeout(timeout)
          apiPromise = null
          // Leaving the dead tag in the document would make the next attempt
          // skip the `querySelector` branch below and wait out the full
          // timeout against a script that is never going to load, so Retry
          // gets a clean slate instead.
          script.remove()
          reject(new Error('YouTube unavailable'))
        }
        document.head.appendChild(script)
      }
    })
  }
  return apiPromise
}

const SUPPORTED_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'weba'])

function provider(url: string): Provider | null {
  try {
    const trimmed = url.trim()
    if (!trimmed) return null
    const u = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com' || host === 'music.youtube.com') return 'youtube'
    if (host === 'open.spotify.com' || host === 'spotify.com') return 'spotify'
    if (host === 'music.yandex.ru' || host === 'music.yandex.com') return 'yandex'
    // Direct link to an audio file streams through <audio> — only if extension matches
    // the six required formats plus common containers. No generic http fallback:
    // treating every https URL as audio misclassifies pages as tracks and
    // makes <audio> issue a CORS/noise request for HTML.
    const ext = u.pathname.split('.').pop()?.split('?')[0]?.toLowerCase() ?? ''
    if (SUPPORTED_AUDIO_EXTS.has(ext)) return 'audio'
    if (/\.(mp3|ogg|oga|wav|m4a|flac|aac|opus|weba)($|\?)/i.test(u.pathname)) return 'audio'
  } catch {}
  return null
}

function isSupportedAudioUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const ext = u.pathname.split('.').pop()?.split('?')[0]?.toLowerCase() ?? ''
    return SUPPORTED_AUDIO_EXTS.has(ext)
  } catch {
    return false
  }
}

function sanitizeAudioSrc(url: string): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  // Allow blob: and data:audio/* for cached / locally-imported audio; otherwise require safe http(s)
  if (trimmed.startsWith('blob:')) return trimmed
  if (trimmed.startsWith('data:audio/')) return trimmed
  // Fall back to the shared sanitizer which blocks javascript:, file:, etc.
  const sanitized = sanitizeUrl(trimmed)
  if (!sanitized || !isSafeUrl(sanitized)) return null
  // Extra gate: must be http(s) and ideally have a supported extension, but
  // allow extension-less streaming URLs (e.g. HLS) — the <audio> element will
  // error gracefully if the format is truly unsupported.
  try {
    const u = new URL(sanitized)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  } catch {
    return null
  }
  return sanitized
}

function videoId(url: string): string | null {
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

/** Yandex's public embed widget streams the track itself — no auth, no download. */
function yandexEmbed(url: string): string | null {
  try {
    const u = new URL(url)
    const withAlbum = u.pathname.match(/\/album\/(\d+)\/track\/(\d+)/)
    if (withAlbum) return `https://music.yandex.ru/iframe/#track/${withAlbum[2]}/${withAlbum[1]}`
    const trackOnly = u.pathname.match(/\/track\/(\d+)/)
    if (trackOnly) return `https://music.yandex.ru/iframe/#track/${trackOnly[1]}`
  } catch {}
  return null
}

/** Spotify's oEmbed-style iframe — plays preview inline. */
function spotifyEmbed(url: string): string | null {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/)
    if (m) return `https://open.spotify.com/embed/${m[1]}/${m[2]}`
  } catch {}
  return null
}

function titleFor(kind: Provider, url: string): string {
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

async function fetchTrackTitle(kind: Provider, url: string): Promise<string | null> {
  if (kind === 'youtube') {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
      if (res.ok) {
        const data = (await res.json()) as { title?: string }
        if (data.title) return data.title
      }
    } catch {}
  }
  return null
}

/** A playlist that survived a round-trip through localStorage, or null. */
function coerceList(value: unknown): Playlist | null {
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

function read(key: string): Playlist[] {
  const fallback = (): Playlist[] => [{ id: crypto.randomUUID(), name: 'My playlist', tracks: [] }]
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    // Anything hand-edited, half-written or left by an older build reaches
    // this widget as `lists`, and a single entry without a `tracks` array
    // would take the whole render down with it.
    if (!Array.isArray(v)) return fallback()
    const lists = v.map(coerceList).filter((p): p is Playlist => p !== null)
    return lists.length ? lists : fallback()
  } catch {
    return fallback()
  }
}

const format = (value: number): string => {
  if (!Number.isFinite(value)) return '--:--'
  const n = Math.max(0, Math.floor(value))
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}

export default function MusicPlayerWidget({ widgetId }: { widgetId: string }): React.JSX.Element {
  const key = `orcspace-music-playlists:${widgetId}`
  const [lists, setLists] = useState(() => read(key))
  const [listIndex, setListIndex] = useState(0)
  const [trackIndex, setTrackIndex] = useState(0)
  const [draft, setDraft] = useState('')
  const [name, setName] = useState('')
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [ytError, setYtError] = useState<string | null>(null)
  const [ytRetry, setYtRetry] = useState(0)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrub, setScrub] = useState<number | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const volKey = `orcspace-music-volume:${widgetId}`
  const muteKey = `orcspace-music-muted:${widgetId}`
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem(volKey))
      return Number.isFinite(v) && v >= 0 ? Math.min(100, Math.round(v)) : 100
    } catch {
      return 100
    }
  })
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(muteKey) === '1'
    } catch {
      return false
    }
  })
  const hostRef = useRef<HTMLDivElement>(null)
  const player = useRef<Player | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const list = lists[listIndex] ?? lists[0]
  const track = list?.tracks[trackIndex]
  const id = track?.provider === 'youtube' ? videoId(track.url) : null
  const listRef = useRef(list)
  useEffect(() => {
    listRef.current = list
  }, [list])
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(lists))
    } catch {}
  }, [key, lists])

  // Reads the playlist through a ref so a track queued from inside the
  // YouTube effect always advances against the current tracklist.
  const advance = (delta: 1 | -1): void => {
    const currentList = listRef.current
    if (!currentList || currentList.tracks.length === 0) return
    setTrackIndex((i) => (i + delta + currentList.tracks.length) % currentList.tracks.length)
  }

  useEffect(() => {
    if (!id || !hostRef.current) {
      try {
        player.current?.destroy()
      } catch {}
      player.current = null
      setReady(false)
      setPlaying(false)
      return
    }

    let cancelled = false
    setReady(false)
    setYtError(null)

    // Clear previous children and create dedicated element for YT to replace
    // This isolates the YouTube iframe from React's virtual DOM reconciliation.
    hostRef.current.innerHTML = ''
    const mountEl = document.createElement('div')
    mountEl.style.width = '100%'
    mountEl.style.height = '100%'
    hostRef.current.appendChild(mountEl)

    void youtubeApi()
      .then((api) => {
        if (cancelled || !hostRef.current || !id) return
        const p = new api.Player(mountEl, {
          videoId: id,
          playerVars: {
            autoplay: 1,
            controls: 0,
            rel: 0,
            playsinline: 1,
            enablejsapi: 1,
            // Must be the page's real http(s) origin — the IFrame API embeds
            // it as a literal query param and validates postMessage commands
            // (play/pause/seek) against it, rejecting the whole embed
            // (error 2) if it isn't a well-formed http(s) origin. The main
            // process now always serves the app over http://localhost (see
            // serveRenderer in src/main/index.ts), so this is safe to send
            // unconditionally in both dev and the packaged app.
            origin: window.location.origin
          },
          events: {
            onReady: () => {
              if (cancelled) return
              player.current = p
              setReady(true)
              try {
                const dur = p.getDuration()
                if (Number.isFinite(dur) && dur > 0) setDuration(dur)
                if (muted) p.mute()
                else {
                  p.unMute()
                  p.setVolume(volume)
                }
                p.playVideo()
              } catch {}
              try {
                const info = p.getVideoData?.()
                const fetched = info?.title
                const targetId = track?.id
                if (fetched && targetId) {
                  // Guarded, because this runs on every player mount: mapping
                  // unconditionally would hand back a fresh array each time
                  // and re-render plus rewrite localStorage for nothing.
                  setLists((prev) =>
                    prev.some((pl) => pl.tracks.some((t) => t.id === targetId && t.title === 'YouTube track'))
                      ? prev.map((pl) => ({
                          ...pl,
                          tracks: pl.tracks.map((t) =>
                            t.id === targetId && t.title === 'YouTube track' ? { ...t, title: fetched } : t
                          )
                        }))
                      : prev
                  )
                }
              } catch {}
            },
            onStateChange: (e) => {
              if (cancelled) return
              if (e.data === api.PlayerState.PLAYING) {
                setPlaying(true)
                setYtError(null)
                setMediaError(null)
                try {
                  const dur = p.getDuration()
                  if (Number.isFinite(dur) && dur > 0) setDuration(dur)
                } catch {}
              } else if (e.data === api.PlayerState.PAUSED) {
                setPlaying(false)
              } else if (e.data === api.PlayerState.ENDED) {
                setPlaying(false)
                if ((listRef.current?.tracks.length ?? 0) <= 1) {
                  try {
                    p.seekTo(0, true)
                    p.playVideo()
                  } catch {}
                } else {
                  advance(1)
                }
              }
            },
            onError: (e) => {
              if (cancelled) return
              setReady(false)
              setPlaying(false)
              const msg =
                e.data === 101 || e.data === 150
                  ? 'Video cannot be embedded by owner request.'
                  : e.data === 100
                  ? 'Video not found or removed.'
                  : 'YouTube playback error.'
              setYtError(msg)
            }
          }
        })
        player.current = p
      })
      .catch(() => {
        if (!cancelled) {
          setReady(false)
          setYtError('YouTube player failed to load — check your connection.')
        }
      })

    return () => {
      cancelled = true
      try {
        player.current?.destroy()
      } catch {}
      player.current = null
      if (hostRef.current) {
        hostRef.current.innerHTML = ''
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ytRetry])

  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => {
      if (player.current && typeof player.current.getCurrentTime === 'function') {
        try {
          const cur = player.current.getCurrentTime()
          const dur = player.current.getDuration()
          if (Number.isFinite(cur)) setCurrent(cur)
          if (Number.isFinite(dur) && dur > 0) setDuration(dur)
        } catch {}
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [ready])

  useEffect(() => {
    setCurrent(0)
    setDuration(0)
    setScrub(null)
    setMediaError(null)
    dragging.current = false
    if (track?.provider === 'audio' && !sanitizeAudioSrc(track.url)) {
      setMediaError('Unsupported or unsafe audio link — use mp3, wav, ogg, flac, aac or m4a over https.')
    }
  }, [track?.id, track?.url, track?.provider])

  useEffect(() => {
    try {
      localStorage.setItem(volKey, String(volume))
    } catch {}
  }, [volKey, volume])

  useEffect(() => {
    try {
      localStorage.setItem(muteKey, muted ? '1' : '0')
    } catch {}
  }, [muteKey, muted])

  // Unmount audio cleanup: pause, revoke src, and abandon any pending play
  // promise so the widget does not leak a playing <audio> after removal.
  useEffect(() => {
    return () => {
      const a = audioRef.current
      if (a) {
        try {
          a.pause()
          // Removing src and calling load() releases the network resource and
          // clears the internal decoder; without this a removed-but-playing
          // element keeps its HTTP stream and audio thread alive.
          a.removeAttribute('src')
          a.load()
        } catch {}
      }
      try {
        player.current?.destroy()
      } catch {}
      player.current = null
      if (hostRef.current) hostRef.current.innerHTML = ''
    }
  }, [])

  useEffect(() => {
    const a = audioRef.current
    if (a) {
      a.volume = volume / 100
      a.muted = muted
    }
    if (player.current && ready) {
      try {
        if (muted) {
          player.current.mute()
        } else {
          player.current.unMute()
          player.current.setVolume(volume)
        }
      } catch {}
    }
  }, [volume, muted, ready, track?.id])

  const audioSrc = track?.provider === 'audio' ? sanitizeAudioSrc(track.url) : null
  const controllable = !!id || (track?.provider === 'audio' && !!audioSrc)
  const canSeek = Number.isFinite(duration) && duration > 0
  const shown = scrub ?? current
  const pct = canSeek ? Math.min(100, Math.max(0, (shown / duration) * 100)) : 0

  const seekTo = (seconds: number): void => {
    const target = canSeek ? Math.min(Math.max(0, seconds), duration) : Math.max(0, seconds)
    if (track?.provider === 'audio') {
      const a = audioRef.current
      if (a) {
        a.currentTime = target
        setCurrent(target)
      }
      return
    }
    if (player.current && ready) {
      try {
        player.current.seekTo(target, true)
        setCurrent(target)
      } catch {}
    }
  }

  const stop = (): void => {
    if (track?.provider === 'audio') {
      const a = audioRef.current
      if (a) {
        a.pause()
        a.currentTime = 0
      }
    } else if (player.current && ready) {
      try {
        player.current.pauseVideo()
        player.current.seekTo(0, true)
      } catch {}
    }
    setPlaying(false)
    setCurrent(0)
    setScrub(null)
  }

  const togglePlay = (): void => {
    if (track?.provider === 'audio') {
      const a = audioRef.current
      if (!a) return
      if (a.paused) {
        void a.play().catch(() => setMediaError('Playback was blocked — press play again.'))
      } else {
        a.pause()
      }
    } else if (player.current && ready) {
      try {
        if (playing) {
          player.current.pauseVideo()
          setPlaying(false)
        } else {
          player.current.playVideo()
          setPlaying(true)
        }
      } catch {}
    }
  }

  const timeAt = (clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || !canSeek) return 0
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration))
  }

  const onBarDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!canSeek) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    setScrub(timeAt(e.clientX))
  }

  const onBarMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragging.current) setScrub(timeAt(e.clientX))
  }

  const onBarUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    const target = timeAt(e.clientX)
    setScrub(null)
    seekTo(target)
  }

  const onBarKey = (e: React.KeyboardEvent): void => {
    if (!canSeek) return
    const at = scrub ?? current
    const step =
      e.key === 'ArrowLeft'
        ? -5
        : e.key === 'ArrowRight'
        ? 5
        : e.key === 'ArrowDown'
        ? -30
        : e.key === 'ArrowUp'
        ? 30
        : e.key === 'Home'
        ? -at
        : e.key === 'End'
        ? duration - at
        : 0
    if (!step) return
    e.preventDefault()
    seekTo(at + step)
  }

  const addTrack = (e: React.FormEvent): void => {
    e.preventDefault()
    const url = draft.trim()
    const kind = provider(url)
    if (!list) return
    if (!kind) {
      setMediaError('Unsupported link — use YouTube, Yandex Music, Spotify or a direct audio-file URL.')
      return
    }
    const item: Track = { id: crypto.randomUUID(), url, provider: kind, title: titleFor(kind, url) }
    const newIndex = list.tracks.length
    setLists((prev) => prev.map((p, i) => (i === listIndex ? { ...p, tracks: [...p.tracks, item] } : p)))
    setTrackIndex(newIndex)
    setDraft('')
    setMediaError(null)

    // Fetch real title in background if available
    void fetchTrackTitle(kind, url).then((fetchedTitle) => {
      if (fetchedTitle) {
        setLists((prev) =>
          prev.map((p) => ({
            ...p,
            tracks: p.tracks.map((t) => (t.id === item.id ? { ...t, title: fetchedTitle } : t))
          }))
        )
      }
    })
  }

  const addList = (e: React.FormEvent): void => {
    e.preventDefault()
    const next = { id: crypto.randomUUID(), name: name.trim() || `Playlist ${lists.length + 1}`, tracks: [] }
    setLists((prev) => [...prev, next])
    setListIndex(lists.length)
    setTrackIndex(0)
    setName('')
  }

  const removeTrack = (trackId: string): void => {
    if (!list) return
    const idx = list.tracks.findIndex((t) => t.id === trackId)
    if (idx < 0) return
    setLists((prev) => prev.map((p, pi) => (pi === listIndex ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p)))
    if (idx < trackIndex) setTrackIndex((i) => i - 1)
    else if (idx === trackIndex) setTrackIndex((i) => Math.max(0, Math.min(i, list.tracks.length - 2)))
  }

  if (!list) return <div className="p-4 text-xs text-text-faint">Create a playlist to start.</div>

  const embed = track ? (track.provider === 'yandex' ? yandexEmbed(track.url) : track.provider === 'spotify' ? spotifyEmbed(track.url) : null) : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-y-auto p-3" data-testid="music-player-widget">
      <div className="flex items-center gap-2">
        <Music2 size={16} className="text-accent" />
        <select
          className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1.5 text-xs text-text"
          value={listIndex}
          onChange={(e) => {
            setListIndex(Number(e.target.value))
            setTrackIndex(0)
          }}
        >
          {lists.map((p, i) => (
            <option key={p.id} value={i}>
              {p.name} ({p.tracks.length})
            </option>
          ))}
        </select>
        <button
          className="rounded p-1 text-text-faint hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-text-faint"
          title={lists.length > 1 ? 'Delete playlist' : 'The last playlist cannot be deleted'}
          aria-label={lists.length > 1 ? 'Delete playlist' : 'The last playlist cannot be deleted'}
          disabled={lists.length <= 1}
          onClick={() => {
            setLists((prev) => prev.filter((_, i) => i !== listIndex))
            setListIndex(0)
            setTrackIndex(0)
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <form className="flex gap-1.5" onSubmit={addTrack}>
        <input
          className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1.5 text-[11px] text-text"
          placeholder="YouTube / Yandex Music / Spotify / direct MP3 link"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="rounded bg-accent px-2 text-bg" type="submit" title="Add track" aria-label="Add track">
          <Plus size={13} />
        </button>
      </form>

      <div className="min-h-[64px] flex-1 overflow-auto rounded border border-line bg-bg/50 p-1">
        {list.tracks.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-text-faint">
            Add a song link to this playlist — it starts playing as soon as you add it.
          </div>
        ) : (
          list.tracks.map((t, i) => (
            <div key={t.id} className={`flex items-center gap-1 rounded px-2 py-1.5 ${i === trackIndex ? 'bg-bg-hover' : ''}`}>
              <button
                className="min-w-0 flex-1 truncate text-left text-[11px] text-text"
                title={i === trackIndex ? (playing ? 'Pause' : 'Play') : `Play ${t.title}`}
                onClick={() => {
                  if (i === trackIndex) togglePlay()
                  else setTrackIndex(i)
                }}
              >
                {i === trackIndex && playing ? <Play size={9} className="mr-1 inline text-accent" /> : null}
                {t.title} <span className="text-[9px] uppercase text-text-faint">· {t.provider}</span>
              </button>
              <button className="p-1 text-text-faint hover:text-danger" title={`Remove ${t.title}`} aria-label={`Remove ${t.title}`} onClick={() => removeTrack(t.id)}>
                <Trash2 size={11} />
              </button>
            </div>
          ))
        )}
      </div>

      {track && (
        <div className="flex items-center justify-center gap-2">
          <button
            className="rounded p-1.5 text-text-faint transition hover:text-text disabled:opacity-30"
            disabled={list.tracks.length < 2}
            onClick={() => advance(-1)}
            title="Previous"
          >
            <SkipBack size={14} />
          </button>
          {controllable && (
            <>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-bg shadow transition hover:brightness-110 active:scale-90 disabled:opacity-40"
                disabled={track.provider === 'youtube' && !ready}
                onClick={togglePlay}
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-[1px]" />}
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-text-faint transition hover:border-text-faint hover:text-text active:scale-90"
                onClick={stop}
                title="Stop"
              >
                <SquareStop size={15} />
              </button>
            </>
          )}
          <button
            className="rounded p-1.5 text-text-faint transition hover:text-text disabled:opacity-30"
            disabled={list.tracks.length < 2}
            onClick={() => advance(1)}
            title="Next"
          >
            <SkipForward size={14} />
          </button>
        </div>
      )}

      {id && (
        <div className="relative h-20 overflow-hidden rounded border border-line bg-bg">
          <img
            className="h-full w-full object-cover opacity-50"
            src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
            alt=""
            onError={(e) => {
              const target = e.currentTarget
              if (!target.src.includes('mqdefault')) {
                target.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
              }
            }}
          />
          <div ref={hostRef} className="pointer-events-none absolute inset-0 opacity-0" />
          {ytError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg/80 p-2 text-center">
              <span className="text-[10px] text-danger">{ytError}</span>
              <button
                className="flex h-6 items-center gap-1 rounded bg-accent px-2 text-[10px] text-bg shadow hover:brightness-110"
                onClick={() => {
                  apiPromise = null
                  setYtRetry((n) => n + 1)
                }}
              >
                <RotateCcw size={11} /> Retry
              </button>
            </div>
          ) : (
            <button
              className="absolute inset-0 m-auto h-9 w-9 rounded-full bg-accent text-bg shadow transition hover:brightness-110 active:scale-90 disabled:opacity-50"
              disabled={!ready}
              onClick={togglePlay}
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={15} className="mx-auto" /> : <Play size={15} className="mx-auto translate-x-[1px]" />}
            </button>
          )}
        </div>
      )}

      {controllable && (
        <div className="flex items-center gap-2" data-testid="music-player-seekbar">
          <span className="w-11 text-right text-[10px] tabular-nums text-text-faint">{format(shown)}</span>
          <div
            ref={barRef}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={canSeek ? Math.floor(duration) : 0}
            aria-valuenow={Math.floor(shown)}
            aria-valuetext={format(shown)}
            tabIndex={0}
            className="group relative flex h-4 flex-1 cursor-pointer touch-none items-center"
            onPointerDown={onBarDown}
            onPointerMove={onBarMove}
            onPointerUp={onBarUp}
            onPointerCancel={onBarUp}
            onKeyDown={onBarKey}
          >
            <div className="h-1 w-full overflow-hidden rounded-full bg-line transition-all duration-150 group-hover:h-1.5">
              <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <div
              className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow transition-transform duration-150 group-hover:scale-125 group-active:scale-150"
              style={{ left: `${pct}%`, opacity: canSeek ? 1 : 0 }}
            />
          </div>
          <span className="w-11 text-[10px] tabular-nums text-text-faint">{format(duration)}</span>
        </div>
      )}

      {controllable && (
        <div className="flex items-center justify-end gap-1.5">
          <button
            className="rounded p-1 text-text-faint transition hover:text-text"
            title={muted ? 'Unmute' : 'Mute'}
            onClick={() => setMuted((m) => !m)}
          >
            {muted || volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
          <input
            aria-label="Volume"
            className="w-24 cursor-pointer"
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const v = Number(e.target.value)
              setVolume(v)
              setMuted(v === 0)
            }}
            style={{ accentColor: 'var(--tok-color-accent)' }}
          />
          <span className="w-8 text-[10px] tabular-nums text-text-faint">{muted ? 'off' : `${volume}%`}</span>
        </div>
      )}

      {mediaError && <div className="rounded border border-danger/40 bg-danger/10 p-2 text-[10px] text-danger">{mediaError}</div>}

      {track?.provider === 'audio' && (
        <div className="flex h-14 items-center justify-center gap-2 rounded border border-line bg-bg">
          <Music2 size={15} className={`text-accent ${playing ? 'animate-pulse' : ''}`} />
          <span className="max-w-[75%] truncate text-[11px] text-text">{track.title}</span>
        </div>
      )}

      {track?.provider === 'audio' && audioSrc && (
        <audio
          key={track.id}
          ref={audioRef}
          autoPlay
          preload="metadata"
          crossOrigin="anonymous"
          src={audioSrc}
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => {
            const a = audioRef.current
            if (!a || dragging.current) return
            setCurrent(a.currentTime)
            if (Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration)
          }}
          onLoadedMetadata={() => {
            const a = audioRef.current
            if (a && Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration)
          }}
          onError={() => setMediaError('Could not load this audio — check the link or format (mp3/wav/ogg/flac/aac/m4a).')}
          onEnded={() => {
            const a = audioRef.current
            if ((listRef.current?.tracks.length ?? 0) <= 1 && a) {
              a.currentTime = 0
              void a.play().catch(() => {})
            } else {
              advance(1)
            }
          }}
        />
      )}

      {track?.provider === 'youtube' && !id && (
        <div className="rounded border border-line bg-bg/50 p-2 text-[10px] text-text-faint">
          Could not read a video id from this YouTube link — use a normal watch, youtu.be or shorts URL.
        </div>
      )}

      {(track?.provider === 'yandex' || track?.provider === 'spotify') &&
        (embed ? (
          <iframe
            key={track.id}
            title={track.title}
            src={embed}
            className="w-full rounded border border-line"
            style={{ height: track.provider === 'spotify' ? 80 : 100 }}
            frameBorder={0}
            allow="autoplay; encrypted-media; clipboard-write"
          />
        ) : (
          <div className="rounded border border-line bg-bg/50 p-2 text-[10px] text-text-faint">
            Could not detect a playable track id in this link — open it directly instead.
          </div>
        ))}

      {track && isSafeUrl(track.url) && sanitizeUrl(track.url) && (
        <a className="flex items-center gap-1 text-[10px] text-text-faint hover:text-accent" href={sanitizeUrl(track.url) ?? undefined} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={11} /> Open current track
        </a>
      )}

      <form className="flex gap-1.5" onSubmit={addList}>
        <input
          className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1.5 text-[11px] text-text"
          placeholder="New playlist name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="rounded border border-line px-2 text-[11px] text-text" type="submit">
          Create
        </button>
      </form>
    </div>
  )
}

