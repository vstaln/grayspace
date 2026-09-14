import * as electron from 'electron'
import { join, resolve } from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'
import { isPathWithinRoot, mediaDir } from './media.ts'

const electronAny = electron as unknown as Record<string, any>
const protocol = electronAny.protocol
const net = electronAny.net
const session = electronAny.session





export function setupOrcProtocol(rendererDir = join(__dirname, '../renderer')): void {
  if (!protocol || typeof protocol.handle !== 'function') return

  protocol.handle('orc', async (request: { url: string }) => {
    try {
      const url = new URL(request.url)
      let pathname = decodeURIComponent(url.pathname)
      if (pathname.startsWith('/')) pathname = pathname.slice(1)

      const isMedia = url.hostname === 'media' || pathname.startsWith('media/')
      if (isMedia) {
        const mediaFileName = url.hostname === 'media' ? pathname : pathname.slice(6)
        if (mediaFileName.includes('\0') || mediaFileName.startsWith('.') || mediaFileName.includes('../') || mediaFileName.includes('..\\')) {
          return new Response('Forbidden', { status: 403 })
        }
        const dir = mediaDir()
        const mediaFilePath = resolve(dir, mediaFileName)
        let real: string
        try {
          real = fs.realpathSync(mediaFilePath)
        } catch {
          return new Response('Not Found', { status: 404 })
        }
        if (!isPathWithinRoot(real, dir)) return new Response('Forbidden', { status: 403 })
        let stat: fs.Stats
        try {
          stat = fs.statSync(real)
        } catch {
          return new Response('Not Found', { status: 404 })
        }
        if (!stat.isFile()) return new Response('Not Found', { status: 404 })
        const ext = real.split('.').pop()?.toLowerCase() ?? ''
        const ACTIVE_EXTS = new Set(['html', 'htm', 'svg', 'js', 'jsx', 'ts', 'tsx', 'xml', 'xhtml'])
        const isActive = ACTIVE_EXTS.has(ext)
        const fetched = await net.fetch(pathToFileURL(real).toString())
        const body = await fetched.arrayBuffer()
        const headers = new Headers()
        headers.set('X-Content-Type-Options', 'nosniff')
        headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
        headers.set('Content-Length', String(body.byteLength))
        if (isActive) {
          headers.set('Content-Type', 'text/plain; charset=utf-8')
          headers.set('Content-Disposition', 'attachment')
        } else {
          const ct = fetched.headers.get('content-type')
          if (ct) headers.set('Content-Type', ct)
        }
        return new Response(body, { status: 200, headers })
      }
      if (!pathname || pathname === 'index.html') {
        pathname = 'index.html'
      }

      const filePath = resolve(rendererDir, pathname)
      if (!isPathWithinRoot(filePath, rendererDir)) {
        return new Response('Forbidden', { status: 403 })
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return net.fetch(pathToFileURL(filePath).toString())
      }


      const indexFile = join(rendererDir, 'index.html')
      if (fs.existsSync(indexFile)) {
        return net.fetch(pathToFileURL(indexFile).toString())
      }

      return new Response('Not Found', { status: 404 })
    } catch (err) {
      console.error('orc:// protocol error:', err)
      return new Response('Internal Error', { status: 500 })
    }
  })
}

const configuredSessions = new WeakSet<object>()







export function setupMediaHeaders(targetSession?: any): void {
  const sess = targetSession ?? (typeof session !== 'undefined' ? session.defaultSession : undefined)
  if (!sess || typeof sess !== 'object' || !sess.webRequest) return
  if (configuredSessions.has(sess)) return
  configuredSessions.add(sess)

  const youtubeFilter = {
    urls: [
      '*://*.youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://*.googlevideo.com/*'
    ]
  }

  sess.webRequest.onBeforeSendHeaders(
    youtubeFilter,
    (
      details: { requestHeaders: Record<string, string> },
      callback: (result: { cancel: boolean; requestHeaders?: Record<string, string> }) => void
    ) => {
    const requestHeaders = { ...details.requestHeaders }
    requestHeaders['Referer'] = 'https://orcspace.app/'
    callback({ cancel: false, requestHeaders })
    }
  )

  const frameFilter = {
    urls: [
      '*://*.youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://*.googlevideo.com/*',
      '*://*.spotify.com/*',
      '*://*.yandex.ru/*',
      '*://*.yandex.com/*'
    ]
  }

  sess.webRequest.onHeadersReceived(
    frameFilter,
    (
      details: { responseHeaders: Record<string, string | string[]> },
      callback: (result: { cancel: boolean; responseHeaders?: Record<string, string | string[]> }) => void
    ) => {
    const responseHeaders = { ...details.responseHeaders }
    for (const key of Object.keys(responseHeaders)) {
      const lower = key.toLowerCase()
      if (lower === 'x-frame-options') {
        delete responseHeaders[key]
      } else if (lower === 'content-security-policy') {
        const csp = responseHeaders[key]
        if (Array.isArray(csp)) {
          responseHeaders[key] = csp.map((value: string) => value.replace(/frame-ancestors[^;]+;?/gi, ''))
        } else if (typeof csp === 'string') {
          responseHeaders[key] = csp.replace(/frame-ancestors[^;]+;?/gi, '')
        }
      }
    }
    callback({ cancel: false, responseHeaders })
    }
  )
}
