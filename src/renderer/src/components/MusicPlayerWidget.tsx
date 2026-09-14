import React, { useEffect, useRef, useState } from 'react'
import { Loader2, Music2, Pause, Play, Plus, RotateCcw, SkipBack, SkipForward, SquareStop, Trash2, Volume2, VolumeX } from 'lucide-react'
import {
  coerceList,
  formatDuration as format,
  provider,
  sanitizeAudioSrc,
  spotifyEmbed,
  SUPPORTED_AUDIO_EXTS,
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
  const idxKey = `orcspace-music-index:${widgetId}`
  const [lists, setLists] = useState(() => read(key))
  // Manual-start only: never autoplay after mount/restart. `playing` always
  // starts false and `userWantsPlayRef` only flips on an explicit user gesture.
  const [listIndex, setListIndex] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(idxKey) || 'null') as { list?: number; track?: number } | null
      const li = typeof raw?.list === 'number' && Number.isFinite(raw.list) ? Math.max(0, Math.floor(raw.list)) : 0
      return li
    } catch {
      return 0
    }
  })
  const [trackIndex, setTrackIndex] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(idxKey) || 'null') as { list?: number; track?: number } | null
      const ti = typeof raw?.track === 'number' && Number.isFinite(raw.track) ? Math.max(0, Math.floor(raw.track)) : 0
      return ti
    } catch {
      return 0
    }
  })
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
  const userWantsPlayRef = useRef(false)
  const list = lists[listIndex] ?? lists[0]
  const track = list?.tracks[trackIndex]
  const id = track?.provider === 'youtube' ? videoId(track.url) : null
  const listRef = useRef(list)
  useEffect(() => {
    listRef.current = list
  }, [list])
  useEffect(() => {
    try {
      const persistable = lists.map((pl) => ({
        ...pl,
        tracks: pl.tracks
          .filter((t) => !t.url.startsWith('data:') && t.url.length < 2000 && t.title.length < 500)
          .slice(0, 200)
      }))
      localStorage.setItem(key, JSON.stringify(persistable))
    } catch {}
  }, [key, lists])

  useEffect(() => {
    try {
      localStorage.setItem(idxKey, JSON.stringify({ list: listIndex, track: trackIndex }))
    } catch {}
  }, [idxKey, listIndex, trackIndex])

  // Clamp restored indices (lists may differ in length after restart).
  useEffect(() => {
    if (listIndex >= lists.length) {
      setListIndex(0)
      setTrackIndex(0)
      return
    }
    const count = lists[listIndex]?.tracks.length ?? 0
    if (trackIndex >= Math.max(count, 1)) setTrackIndex(0)
  }, [lists.length, listIndex, trackIndex, lists])

  useEffect(() => {
    const handleAddTrack = (e: Event): void => {
      const detail = (e as CustomEvent<{ widgetId?: string; track?: Track }>).detail
      if (detail && (!detail.widgetId || detail.widgetId === widgetId) && detail.track) {
        setLists((prev) =>
          prev.map((pl, idx) =>
            idx === listIndex ? { ...pl, tracks: [...pl.tracks, detail.track!] } : pl
          )
        )
      }
    }
    window.addEventListener('orcspace:add-music-track', handleAddTrack)
    return () => window.removeEventListener('orcspace:add-music-track', handleAddTrack)
  }, [widgetId, listIndex])



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



          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            autoplay: 0,
            controls: 0,
            rel: 0,
            playsinline: 1,
            enablejsapi: 1,


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
                if (userWantsPlayRef.current) {
                  p.playVideo()
                }
              } catch {}
              try {
                const info = p.getVideoData?.()
                const fetched = info?.title
                const targetId = track?.id
                if (fetched && targetId) {



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
                userWantsPlayRef.current = true
                setPlaying(true)
                setYtError(null)
                setMediaError(null)
                try {
                  const dur = p.getDuration()
                  if (Number.isFinite(dur) && dur > 0) setDuration(dur)
                } catch {}
              } else if (e.data === api.PlayerState.PAUSED) {
                userWantsPlayRef.current = false
                setPlaying(false)
              } else if (e.data === api.PlayerState.ENDED) {
                setPlaying(false)
                if ((listRef.current?.tracks.length ?? 0) <= 1) {
                  try {
                    p.seekTo(0, true)
                    if (userWantsPlayRef.current) {
                      p.playVideo()
                    }
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



  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      const a = audioRef.current
      if (a) {
        try {
          a.pause()



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

  useEffect(() => {
    if (track?.provider === 'audio' && userWantsPlayRef.current) {
      const a = audioRef.current
      if (a && a.paused) {
        void a.play().catch(() => {})
      }
    }
  }, [track?.id, trackIndex])

  const stop = (): void => {
    userWantsPlayRef.current = false
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
        userWantsPlayRef.current = true
        void a.play().catch(() => setMediaError('Playback was blocked — press play again.'))
      } else {
        userWantsPlayRef.current = false
        a.pause()
      }
    } else if (player.current && ready) {
      try {
        if (playing) {
          userWantsPlayRef.current = false
          player.current.pauseVideo()
          setPlaying(false)
        } else {
          userWantsPlayRef.current = true
          player.current.playVideo()
          setPlaying(true)
        }
      } catch {}
    } else if (track?.provider === 'youtube' && !ready) {
      userWantsPlayRef.current = !playing
      setPlaying(!playing)
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
    if (url.startsWith('data:')) {
      setMediaError('Pasting raw audio data is not supported — drop the audio file on the canvas instead.')
      return
    }
    if (url.length > 2000) {
      setMediaError('Link is too long — use a direct audio-file URL.')
      return
    }
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

  const rawEmbed = track ? (track.provider === 'yandex' ? yandexEmbed(track.url) : track.provider === 'spotify' ? spotifyEmbed(track.url) : null) : null
  const embed =
    rawEmbed &&
    (rawEmbed.startsWith('https://open.spotify.com/embed/') || rawEmbed.startsWith('https://music.yandex.ru/iframe/'))
      ? rawEmbed
      : null

  const providerLabel = track?.provider === 'youtube' ? 'YouTube' : track?.provider === 'yandex' ? 'Yandex Music' : track?.provider === 'spotify' ? 'Spotify' : 'Audio file'

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3"
      data-testid="music-player-widget"
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!e.dataTransfer) return
        const dt = e.dataTransfer
        const text = dt.getData('text/plain')
        if (text && provider(text)) {
          const kind = provider(text)!
          const item: Track = { id: crypto.randomUUID(), url: text.trim(), provider: kind, title: titleFor(kind, text) }
          setLists((prev) => prev.map((pl, idx) => (idx === listIndex ? { ...pl, tracks: [...pl.tracks, item] } : pl)))
          void fetchTrackTitle(kind, text).then((fetched) => {
            if (aliveRef.current && fetched) {
              setLists((prev) =>
                prev.map((pl) => ({ ...pl, tracks: pl.tracks.map((t) => (t.id === item.id ? { ...t, title: fetched } : t)) }))
              )
            }
          })
        }
        if (dt.files && dt.files.length > 0) {
          for (const file of Array.from(dt.files)) {
            const ext = (file.name.includes('.') ? file.name.split('.').pop()! : '').toLowerCase()
            const isAudioFile = file.type.startsWith('audio/') || SUPPORTED_AUDIO_EXTS.has(ext)
            if (!isAudioFile) {
              setMediaError(`"${file.name}" is not audio — drop video/docs on the canvas to open them in a viewer.`)
              continue
            }
            const extSafe = ext || (
              file.type === 'audio/wav' || file.type === 'audio/x-wav' ? 'wav'
              : file.type === 'audio/ogg' ? 'ogg'
              : file.type === 'audio/flac' ? 'flac'
              : file.type === 'audio/mp4' || file.type === 'audio/x-m4a' ? 'm4a'
              : file.type === 'audio/webm' ? 'weba'
              : 'mp3'
            )
            try {
              const buf = await file.arrayBuffer()
              const saved = await window.api.media.saveBytes(new Uint8Array(buf), extSafe)
              if (saved && 'name' in saved) {
                const item: Track = {
                  id: crypto.randomUUID(),
                  url: `orc://media/${saved.name}`,
                  title: file.name.replace(/\.[a-z0-9]+$/i, ''),
                  provider: 'audio'
                }
                setLists((prev) => prev.map((pl, idx) => (idx === listIndex ? { ...pl, tracks: [...pl.tracks, item] } : pl)))
              }
            } catch (err) {
              console.error('Failed to add dropped file to music player:', err)
            }
          }
        }
      }}
    >
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill border border-line bg-bg-hover text-text">
          <Music2 size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-faint">Music player</div>
          <div className="truncate text-[11px] text-text">{list.name}</div>
        </div>
        <button
          className="rounded-panel p-1.5 text-text-faint transition hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
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

      <div className="flex items-center gap-2 rounded-panel border border-line bg-bg p-2">
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
        <span className="rounded-panel border border-line px-1.5 py-0.5 text-[9px] tabular-nums text-text-faint">{list.tracks.length} tracks</span>
      </div>

      <div className="rounded-panel border border-line bg-bg-hover p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-panel border border-line bg-bg text-text">
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
                <div className="h-1 w-full overflow-hidden rounded-pill bg-line transition-all duration-150 group-hover:h-1.5">
                  <div className="h-full rounded-pill bg-accent" style={{ width: `${pct}%` }} />
                </div>
                <div
                  className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-accent shadow transition-transform duration-150 group-hover:scale-125 group-active:scale-150"
                  style={{ left: `${pct}%`, opacity: canSeek ? 1 : 0 }}
                />
              </div>
              <span className="w-9 text-[10px] tabular-nums text-text-faint">{format(duration)}</span>
            </div>
            <div className="mt-2 flex items-center justify-center gap-2">
              <button className="rounded-panel p-1.5 text-text-faint transition hover:bg-bg hover:text-text disabled:opacity-30" disabled={list.tracks.length < 2} onClick={() => advance(-1)} title="Previous">
                <SkipBack size={14} />
              </button>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-pill bg-accent text-bg shadow transition hover:brightness-110 active:scale-90 disabled:opacity-40"
                disabled={track?.provider === 'youtube' && !ready}
                onClick={togglePlay}
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-[1px]" />}
              </button>
              <button className="flex h-8 w-8 items-center justify-center rounded-pill border border-line text-text-faint transition hover:border-text-faint hover:text-text active:scale-90" onClick={stop} title="Stop">
                <SquareStop size={15} />
              </button>
              <button className="rounded-panel p-1.5 text-text-faint transition hover:bg-bg hover:text-text disabled:opacity-30" disabled={list.tracks.length < 2} onClick={() => advance(1)} title="Next">
                <SkipForward size={14} />
              </button>
            </div>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                className="rounded-panel p-1 text-text-faint transition hover:bg-bg hover:text-text"
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
          className="min-w-0 flex-1 rounded-panel border border-line bg-bg px-2.5 py-2 text-[11px] text-text outline-none transition placeholder:text-text-faint focus:border-text-faint"
          placeholder="Paste YouTube, Yandex, Spotify or audio link"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="rounded-panel bg-accent px-2.5 text-bg disabled:cursor-not-allowed disabled:opacity-40" type="submit" title="Add track" aria-label="Add track" disabled={!draft.trim()}>
          <Plus size={14} />
        </button>
      </form>

      <div className="flex min-h-[72px] flex-1 flex-col overflow-hidden rounded-panel border border-line bg-bg">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-text-faint">Queue</span>
          {track && <span className="max-w-[55%] truncate text-[10px] text-text-faint">{track.title}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {list.tracks.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-text-faint">Your queue is empty. Add a song link above.</div>
          ) : (
            list.tracks.map((t, i) => (
              <div key={t.id} className={`group flex items-center gap-2 rounded-panel px-2 py-2 ${i === trackIndex ? 'bg-bg-hover' : 'hover:bg-bg-hover/60'}`}>
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 truncate text-left text-[11px] text-text"
                  title={i === trackIndex ? (playing ? 'Pause' : 'Play') : `Play ${t.title}`}
                  onClick={() => {
                    if (i === trackIndex) {
                      togglePlay()
                    } else {
                      userWantsPlayRef.current = true
                      setTrackIndex(i)
                      setPlaying(true)
                    }
                  }}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-line text-text-faint">
                    {i === trackIndex && playing ? <Loader2 size={12} className="animate-spin" /> : <Music2 size={12} />}
                  </span>
                  <span className="min-w-0 truncate">{t.title}</span>
                  <span className="shrink-0 text-[9px] uppercase text-text-faint">{t.provider}</span>
                </button>
                <button className="rounded-panel p-1 text-text-faint opacity-60 transition hover:bg-bg hover:text-text group-hover:opacity-100" title={`Remove ${t.title}`} aria-label={`Remove ${t.title}`} onClick={() => removeTrack(t.id)}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {id && (
        <div className="pointer-events-none absolute left-0 top-0 h-20 w-full overflow-hidden rounded-panel border border-line bg-bg opacity-[0.01]" aria-hidden="true">
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
        <div className="flex items-center gap-2 rounded-panel border border-line bg-bg p-2 text-[10px] text-text-faint">
          <span className="min-w-0 flex-1">{ytError}</span>
          <button
            className="flex shrink-0 items-center gap-1 rounded-panel border border-line px-2 py-1 text-text transition hover:bg-bg-hover"
            onClick={() => {
              apiPromise = null
              setYtRetry((n) => n + 1)
            }}
          >
            <RotateCcw size={11} /> Retry
          </button>
        </div>
      )}

      {mediaError && <div className="rounded-panel border border-line bg-bg p-2 text-[10px] text-text-faint">{mediaError}</div>}

      {track?.provider === 'audio' && audioSrc && (
        <audio
          key={track.id}
          ref={audioRef}
          preload="metadata"
          autoPlay={false}
          crossOrigin="anonymous"
          src={audioSrc}
          className="hidden"
          onPlay={() => {
            userWantsPlayRef.current = true
            setPlaying(true)
          }}
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
              if (userWantsPlayRef.current) {
                void a.play().catch(() => {})
              }
            } else {
              advance(1)
            }
          }}
        />
      )}

      {track?.provider === 'youtube' && !id && <div className="rounded-panel border border-line bg-bg p-2 text-[10px] text-text-faint">Could not read a video id from this YouTube link — use a normal watch, youtu.be or shorts URL.</div>}

      {(track?.provider === 'yandex' || track?.provider === 'spotify') &&
        (embed ? (
          <div className="overflow-hidden rounded-panel border border-line bg-bg">
            <div className="border-b border-line px-3 py-2 text-[10px] text-text-faint">Controls for {providerLabel} are available below.</div>
            <iframe
              key={track.id}
              title={track.title}
              src={embed}
              className="w-full"
              style={{ height: track.provider === 'spotify' ? 80 : 100 }}
              frameBorder={0}
              sandbox="allow-scripts allow-same-origin allow-presentation"
              allow="encrypted-media; autoplay"
              loading="lazy"
              referrerPolicy="no-referrer"
              tabIndex={0}
            />
          </div>
        ) : (
          <div className="rounded-panel border border-line bg-bg p-2 text-[10px] text-text-faint">Could not detect a playable track id in this link.</div>
        ))}

      <form className="flex gap-1.5 border-t border-line pt-2" onSubmit={addList}>
        <input className="min-w-0 flex-1 rounded-panel border border-line bg-bg px-2.5 py-2 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-text-faint" placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="rounded-panel border border-line px-2.5 text-[11px] text-text transition hover:bg-bg-hover" type="submit">Create</button>
      </form>
    </div>
  )
}

