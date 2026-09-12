import { describe, it } from 'node:test'
import assert from 'node:assert/strict'



import { isSafeUrl, sanitizeUrl, safeHref } from '../renderer/src/lib/sanitizeUrl.ts'
import { DRAW_CLICK_THRESHOLD_PX } from '../renderer/src/lib/canvasMetrics.ts'
import { parseWidgetInvocation } from '../renderer/src/lib/commandInput.ts'
import { pasteHasImage } from '../renderer/src/lib/paste.ts'
import {
  provider,
  sanitizeAudioSrc,
  videoId,
  yandexEmbed,
  spotifyEmbed,
  coerceList,
  formatDuration
} from '../renderer/src/lib/music.ts'

describe('sanitizeUrl', () => {
  it('allows http/https', () => {
    assert.equal(isSafeUrl('https://example.com'), true)
    assert.equal(isSafeUrl('http://example.com/path?q=1'), true)
  })
  it('blocks javascript: and data:', () => {
    assert.equal(isSafeUrl('javascript:alert(1)'), false)
    assert.equal(isSafeUrl('  javascript:alert(1)'), false)
    assert.equal(isSafeUrl('data:text/html,hi'), false)
    assert.equal(isSafeUrl('vbscript:msg'), false)
  })
  it('allows relative and fragments', () => {
    assert.equal(isSafeUrl('/path'), true)
    assert.equal(isSafeUrl('#anchor'), true)
    assert.equal(isSafeUrl('./relative'), true)
  })
  it('sanitizeUrl returns fallback on unsafe', () => {
    assert.equal(sanitizeUrl('javascript:alert(1)', null), null)
    assert.equal(sanitizeUrl('https://safe.com', null), 'https://safe.com')
  })
  it('safeHref mirrors sanitizeUrl', () => {
    assert.equal(safeHref('https://a.b'), 'https://a.b')
    assert.equal(safeHref('javascript:x'), null)
  })
  it('blocks obfuscated whitespace javascript', () => {
    assert.equal(isSafeUrl('  java\tscript:alert(1)'), false)
  })
})

describe('canvasMetrics', () => {
  it('DRAW_CLICK_THRESHOLD_PX is stable', () => {
    assert.equal(DRAW_CLICK_THRESHOLD_PX, 4)
    assert.ok(Number.isFinite(DRAW_CLICK_THRESHOLD_PX))
  })
})

describe('command input', () => {
  it('recognizes slash, dot, at and plain widget shortcuts', () => {
    assert.equal(parseWidgetInvocation('/terminal')?.kind, 'terminal')
    assert.equal(parseWidgetInvocation('.files')?.kind, 'files')
    assert.equal(parseWidgetInvocation('@planner')?.kind, 'planner')
    assert.equal(parseWidgetInvocation('terminal')?.kind, 'terminal')
  })

  it('keeps a trailing terminal command for the new widget', () => {
    assert.deepEqual(parseWidgetInvocation('/terminal npm test'), {
      kind: 'terminal',
      initialCommand: 'npm test'
    })
  })

  it('respects a configured prefix', () => {
    assert.equal(parseWidgetInvocation('/terminal', '.') , null)
    assert.equal(parseWidgetInvocation('.terminal', '.')?.kind, 'terminal')
  })
})

describe('clipboard paste detection', () => {
  const clipboardEvent = (plain: string, html: string): ClipboardEvent => ({
    clipboardData: {
      files: [],
      items: [],
      types: html ? ['text/plain', 'text/html'] : ['text/plain'],
      getData: (type: string) => type === 'text/html' ? html : plain
    }
  } as unknown as ClipboardEvent)

  it('detects an HTML image even when plain text is only its alt label', () => {
    assert.equal(pasteHasImage(clipboardEvent('Image One', '<p><img src="data:image/png;base64,abc" alt="Image One"></p>')), true)
  })

  it('does not classify ordinary rich text as an image', () => {
    assert.equal(pasteHasImage(clipboardEvent('hello', '<p>hello</p>')), false)
  })
})

describe('music helpers', () => {
  it('identifies music providers correctly', () => {
    assert.equal(provider('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube')
    assert.equal(provider('https://youtu.be/dQw4w9WgXcQ'), 'youtube')
    assert.equal(provider('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 'spotify')
    assert.equal(provider('https://music.yandex.ru/album/123/track/456'), 'yandex')
    assert.equal(provider('https://example.com/stream/song.mp3'), 'audio')
    assert.equal(provider('https://example.com/song.flac?download=1'), 'audio')
    assert.equal(provider('https://example.com/not-music.html'), null)
    assert.equal(provider(''), null)
  })

  it('extracts YouTube videoId across formats', () => {
    assert.equal(videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
    assert.equal(videoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
    assert.equal(videoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
    assert.equal(videoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
    assert.equal(videoId('https://example.com/invalid'), null)
  })

  it('builds valid Yandex and Spotify embed URLs', () => {
    assert.equal(
      yandexEmbed('https://music.yandex.ru/album/123/track/456'),
      'https://music.yandex.ru/iframe/#track/456/123'
    )
    assert.equal(
      yandexEmbed('https://music.yandex.ru/track/789'),
      'https://music.yandex.ru/iframe/#track/789'
    )
    assert.equal(
      spotifyEmbed('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
      'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT'
    )
  })

  it('sanitizes audio source URLs', () => {
    assert.equal(sanitizeAudioSrc('https://cdn.example.com/song.mp3'), 'https://cdn.example.com/song.mp3')
    assert.equal(sanitizeAudioSrc('blob:http://localhost:5173/uuid-123'), 'blob:http://localhost:5173/uuid-123')
    assert.equal(sanitizeAudioSrc('data:audio/mp3;base64,...'), 'data:audio/mp3;base64,...')
    assert.equal(sanitizeAudioSrc('javascript:alert(1)'), null)
    assert.equal(sanitizeAudioSrc('file:///C:/secret.mp3'), null)
  })

  it('coerces and validates stored playlists safely', () => {
    assert.equal(coerceList(null), null)
    assert.equal(coerceList('invalid'), null)
    assert.equal(coerceList({ id: '123' }), null)

    const valid = coerceList({
      id: 'pl-1',
      name: 'Chill Vibes',
      tracks: [
        { id: 't-1', url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Song', provider: 'youtube' },
        { id: 't-invalid', url: 'javascript:x', title: 'bad', provider: 'unknown' }
      ]
    })
    assert.ok(valid)
    assert.equal(valid.id, 'pl-1')
    assert.equal(valid.name, 'Chill Vibes')
    assert.equal(valid.tracks.length, 1)
    assert.equal(valid.tracks[0].provider, 'youtube')
  })

  it('formats track duration nicely', () => {
    assert.equal(formatDuration(0), '0:00')
    assert.equal(formatDuration(65), '1:05')
    assert.equal(formatDuration(3665), '1:01:05')
    assert.equal(formatDuration(NaN), '--:--')
  })
})
