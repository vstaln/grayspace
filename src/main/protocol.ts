import * as electron from 'electron'
import { join, resolve, normalize, sep } from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'

const electronAny = electron as unknown as Record<string, any>
const protocol = electronAny.protocol
const net = electronAny.net
const session = electronAny.session





export function setupOrcProtocol(rendererDir = join(__dirname, '../renderer')): void {
  if (!protocol || typeof protocol.handle !== 'function') return

  protocol.handle('orc', (request: { url: string }) => {
    try {
      const url = new URL(request.url)
      let pathname = decodeURIComponent(url.pathname)
      if (pathname.startsWith('/')) pathname = pathname.slice(1)
      if (!pathname || pathname === 'index.html') {
        pathname = 'index.html'
      }

      const filePath = resolve(rendererDir, pathname)
      const normalizedRenderer = normalize(rendererDir)
      const baseWithSep = normalizedRenderer.endsWith(sep) ? normalizedRenderer : normalizedRenderer + sep


      if (filePath !== normalizedRenderer && !filePath.startsWith(baseWithSep)) {
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
    delete responseHeaders['x-frame-options']
    delete responseHeaders['X-Frame-Options']
    const csp = responseHeaders['content-security-policy']
    if (Array.isArray(csp)) {
      responseHeaders['content-security-policy'] = csp.map((value: string) => value.replace(/frame-ancestors[^;]+;?/gi, ''))
    } else if (typeof csp === 'string') {
      responseHeaders['content-security-policy'] = csp.replace(/frame-ancestors[^;]+;?/gi, '')
    }
    callback({ cancel: false, responseHeaders })
    }
  )
}
