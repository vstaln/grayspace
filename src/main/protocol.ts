import { protocol, net } from 'electron'
import { join, resolve, normalize, sep } from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'

/**
 * Handles `orc://app/...` requests directly from the packaged/built renderer files
 * without opening any HTTP/TCP port.
 */
export function setupOrcProtocol(rendererDir = join(__dirname, '../renderer')): void {
  if (!protocol || typeof protocol.handle !== 'function') return

  protocol.handle('orc', (request) => {
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

      // Path traversal security check
      if (filePath !== normalizedRenderer && !filePath.startsWith(baseWithSep)) {
        return new Response('Forbidden', { status: 403 })
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return net.fetch(pathToFileURL(filePath).toString())
      }

      // SPA fallback
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
