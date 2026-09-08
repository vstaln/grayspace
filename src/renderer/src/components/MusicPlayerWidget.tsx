import React, { useEffect, useRef, useState } from 'react'
import { Loader2, Music2, Pause, Play, Plus, RotateCcw, SkipBack, SkipForward, SquareStop, Trash2, Volume2, VolumeX } from 'lucide-react'
import {
  coerceList,
  formatDuration as format,
  provider,
  sanitizeAudioSrc,
  spotifyEmbed,
  titleFor,
  videoId,
  yandexEmbed,
  type Playlist,
  type Provider,
  type Track
} from '../lib/music'

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
      host?: string
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
      const wrappedHandler = (): void => {
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
      // Preserve existing queue: chain instead of overwrite. The previous
      // handler runs exactly once, inside wrappedHandler.
      window.onYouTubeIframeAPIReady = wrappedHandler

      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const script = document.createElement('script')
        script.src = 'https://www.youtube.com/iframe_api'
        script.async = true
        script.onerror = () => {
          clearTimeout(timeout)
          apiPromise = null
          script.remove()
          reject(new Error('YouTube unavailable'))
        }
        document.head.appendChild(script)
      }
    })
  }
  return apiPromise
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

function read(key: string): Playlist[] {
  const fallback = (): Playlist[] => [{ id: crypto.randomUUID(), name: 'My playlist', tracks: [] }]
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(v)) return fallback()
    const lists = v.map(coerceList).filter((p): p is Playlist => p !== null)
    return lists.length ? lists : fallback()
  } catch {
    return fallback()
  }
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
  const aliveRef = useRef(true)
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
          // Keep the preview inside the widget and avoid loading the full
          // YouTube site. The privacy-enhanced host also works around a
          // subset of provider-specific embed failures.
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            autoplay: 1,
            controls: 0,
            rel: 0,
            playsinline: 1,
            enablejsapi: 1,
            // YouTube rejects custom schemes as an API origin. Packaged builds
            // use `orc://app`, so keep a valid HTTPS origin for the iframe API.
            origin: window.location.origin.startsWith('http') ? window.location.origin : 'https://www.youtube.com'
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
                  ? 'This video is blocked by the owner for embedded playback.'
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
    // Do not keep Electron alive when widget is hidden/minimized
    ;(timer as unknown as { unref?: () => void }).unref?.()
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

  const preMuteVolume = useRef(volume)

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
    aliveRef.current = true
    return () => {
      aliveRef.current = false
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
      if (aliveRef.current && fetchedTitle) {
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

  const providerLabel = track?.provider === 'youtube' ? 'YouTube' : track?.provider === 'yandex' ? 'Yandex Music' : track?.provider === 'spotify' ? 'Spotify' : 'Audio file'

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3" data-testid="music-player-widget">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-bg-hover text-text">
          <Music2 size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-faint">Music player</div>
          <div className="truncate text-[11px] text-text">{list.name}</div>
        </div>
        <button
          className="rounded-md p-1.5 text-text-faint transition hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
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

      <div className="flex items-center gap-2 rounded-lg border border-line bg-bg p-2">
        <select
          className="min-w-0 flex-1 bg-transparent text-[11px] text-text outline-none"
          value={listIndex}
          aria-label="Playlist"
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
        <span className="rounded border border-line px-1.5 py-0.5 text-[9px] tabular-nums text-text-faint">{list.tracks.length} tracks</span>
      </div>

      <div className="rounded-xl border border-line bg-bg-hover p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-line bg-bg text-text">
            <Music2 size={25} className={playing ? 'animate-pulse' : ''} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-text-faint">Now playing</div>
            <div className="truncate text-sm font-medium text-text">{track?.title ?? 'Nothing queued'}</div>
            <div className="mt-1 truncate text-[10px] text-text-faint">{track ? `${providerLabel} · ${playing ? 'Playing' : 'Paused'}` : 'Add a link below to begin'}</div>
          </div>
        </div>

        {controllable && (
          <>
            <div className="mt-3 flex items-center gap-2" data-testid="music-player-seekbar">
              <span className="w-9 text-right text-[10px] tabular-nums text-text-faint">{format(shown)}</span>
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
              <span className="w-9 text-[10px] tabular-nums text-text-faint">{format(duration)}</span>
            </div>
            <div className="mt-2 flex items-center justify-center gap-2">
              <button className="rounded-md p-1.5 text-text-faint transition hover:bg-bg hover:text-text disabled:opacity-30" disabled={list.tracks.length < 2} onClick={() => advance(-1)} title="Previous">
                <SkipBack size={14} />
              </button>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-bg shadow transition hover:brightness-110 active:scale-90 disabled:opacity-40"
                disabled={track?.provider === 'youtube' && !ready}
                onClick={togglePlay}
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-[1px]" />}
              </button>
              <button className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-text-faint transition hover:border-text-faint hover:text-text active:scale-90" onClick={stop} title="Stop">
                <SquareStop size={15} />
              </button>
              <button className="rounded-md p-1.5 text-text-faint transition hover:bg-bg hover:text-text disabled:opacity-30" disabled={list.tracks.length < 2} onClick={() => advance(1)} title="Next">
                <SkipForward size={14} />
              </button>
            </div>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                className="rounded-md p-1 text-text-faint transition hover:bg-bg hover:text-text"
                title={muted ? 'Unmute' : 'Mute'}
                onClick={() => {
                  if (!muted) preMuteVolume.current = volume
                  setMuted((m) => !m)
                }}
              >
                {muted || volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
              <input
                aria-label="Volume"
                className="w-24 cursor-pointer"
                type="range"
                min={0}
                max={100}
                value={volume}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setVolume(v)
                  setMuted(v === 0)
                }}
                style={{ accentColor: 'var(--tok-color-accent)' }}
              />
              <span className="w-8 text-[10px] tabular-nums text-text-faint">{muted ? `${preMuteVolume.current}%` : `${volume}%`}</span>
            </div>
          </>
        )}
      </div>

      <form className="flex gap-1.5" onSubmit={addTrack}>
        <input
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-2 text-[11px] text-text outline-none transition placeholder:text-text-faint focus:border-text-faint"
          placeholder="Paste YouTube, Yandex, Spotify or audio link"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="rounded-lg bg-accent px-2.5 text-bg disabled:cursor-not-allowed disabled:opacity-40" type="submit" title="Add track" aria-label="Add track" disabled={!draft.trim()}>
          <Plus size={14} />
        </button>
      </form>

      <div className="flex min-h-[72px] flex-1 flex-col overflow-hidden rounded-xl border border-line bg-bg">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-text-faint">Queue</span>
          {track && <span className="max-w-[55%] truncate text-[10px] text-text-faint">{track.title}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {list.tracks.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-text-faint">Your queue is empty. Add a song link above.</div>
          ) : (
            list.tracks.map((t, i) => (
              <div key={t.id} className={`group flex items-center gap-2 rounded-lg px-2 py-2 ${i === trackIndex ? 'bg-bg-hover' : 'hover:bg-bg-hover/60'}`}>
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 truncate text-left text-[11px] text-text"
                  title={i === trackIndex ? (playing ? 'Pause' : 'Play') : `Play ${t.title}`}
                  onClick={() => {
                    if (i === trackIndex) togglePlay()
                    else setTrackIndex(i)
                  }}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line text-text-faint">
                    {i === trackIndex && playing ? <Loader2 size={12} className="animate-spin" /> : <Music2 size={12} />}
                  </span>
                  <span className="min-w-0 truncate">{t.title}</span>
                  <span className="shrink-0 text-[9px] uppercase text-text-faint">{t.provider}</span>
                </button>
                <button className="rounded p-1 text-text-faint opacity-60 transition hover:bg-bg hover:text-text group-hover:opacity-100" title={`Remove ${t.title}`} aria-label={`Remove ${t.title}`} onClick={() => removeTrack(t.id)}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {id && (
        <div className="pointer-events-none absolute left-0 top-0 h-20 w-full overflow-hidden rounded border border-line bg-bg opacity-[0.01]" aria-hidden="true">
          <img
            className="h-full w-full object-cover"
            src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`}
            alt=""
            onError={(e) => {
              const target = e.currentTarget
              if (!target.src.includes('/default.jpg')) target.src = `https://i.ytimg.com/vi/${id}/default.jpg`
            }}
          />
          <div ref={hostRef} className="absolute inset-0" />
        </div>
      )}

      {ytError && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-bg p-2 text-[10px] text-text-faint">
          <span className="min-w-0 flex-1">{ytError}</span>
          <button
            className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-text transition hover:bg-bg-hover"
            onClick={() => {
              apiPromise = null
              setYtRetry((n) => n + 1)
            }}
          >
            <RotateCcw size={11} /> Retry
          </button>
        </div>
      )}

      {mediaError && <div className="rounded-lg border border-line bg-bg p-2 text-[10px] text-text-faint">{mediaError}</div>}

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

      {track?.provider === 'youtube' && !id && <div className="rounded-lg border border-line bg-bg p-2 text-[10px] text-text-faint">Could not read a video id from this YouTube link — use a normal watch, youtu.be or shorts URL.</div>}

      {(track?.provider === 'yandex' || track?.provider === 'spotify') &&
        (embed ? (
          <div className="overflow-hidden rounded-lg border border-line bg-bg">
            <div className="border-b border-line px-3 py-2 text-[10px] text-text-faint">Controls for {providerLabel} are available below.</div>
            <iframe
              key={track.id}
              title={track.title}
              src={embed}
              className="w-full"
              style={{ height: track.provider === 'spotify' ? 80 : 100 }}
              frameBorder={0}
              allow="autoplay; encrypted-media; clipboard-write"
              tabIndex={0}
            />
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-bg p-2 text-[10px] text-text-faint">Could not detect a playable track id in this link.</div>
        ))}

      <form className="flex gap-1.5 border-t border-line pt-2" onSubmit={addList}>
        <input className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-2 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-text-faint" placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="rounded-lg border border-line px-2.5 text-[11px] text-text transition hover:bg-bg-hover" type="submit">Create</button>
      </form>
    </div>
  )
}

