import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { setupMediaHeaders } from './protocol.ts'

describe('protocol - setupMediaHeaders', () => {
  test('gracefully handles undefined or invalid session', () => {
    assert.doesNotThrow(() => setupMediaHeaders(undefined))
    assert.doesNotThrow(() => setupMediaHeaders(null))
    assert.doesNotThrow(() => setupMediaHeaders({}))
  })

  test('configures YouTube request headers and strips framing headers on responses', () => {
    type BeforeSendListener = (
      details: { url: string; requestHeaders: Record<string, string> },
      cb: (res: { cancel: boolean; requestHeaders?: Record<string, string> }) => void
    ) => void
    type HeadersReceivedListener = (
      details: { url: string; responseHeaders: Record<string, string | string[]> },
      cb: (res: { cancel: boolean; responseHeaders?: Record<string, string | string[]> }) => void
    ) => void
    let beforeSendFilter: { urls: string[] } | null = null
    let beforeSendListener: BeforeSendListener | null = null
    let headersReceivedFilter: { urls: string[] } | null = null
    let headersReceivedListener: HeadersReceivedListener | null = null

    const mockSession = {
      webRequest: {
        onBeforeSendHeaders: (filter: { urls: string[] }, listener: BeforeSendListener) => {
          beforeSendFilter = filter
          beforeSendListener = listener
        },
        onHeadersReceived: (filter: { urls: string[] }, listener: HeadersReceivedListener) => {
          headersReceivedFilter = filter
          headersReceivedListener = listener
        }
      }
    }

    setupMediaHeaders(mockSession)

    assert.ok(beforeSendFilter)
    assert.ok(beforeSendListener)
    assert.ok(headersReceivedFilter)
    assert.ok(headersReceivedListener)

    // Test onBeforeSendHeaders sets Referer
    let interceptedHeaders: Record<string, string> | undefined
    const beforeSend = beforeSendListener as BeforeSendListener
    beforeSend(
      { url: 'https://www.youtube.com/embed/test', requestHeaders: { 'User-Agent': 'Test' } },
      (res) => {
        interceptedHeaders = res.requestHeaders
      }
    )
    assert.strictEqual(interceptedHeaders?.['Referer'], 'https://orcspace.app/')
    assert.strictEqual(interceptedHeaders?.['User-Agent'], 'Test')

    // Test onHeadersReceived strips x-frame-options and frame-ancestors
    let interceptedResponse: Record<string, string | string[]> | undefined
    const headersReceived = headersReceivedListener as HeadersReceivedListener
    headersReceived(
      {
        url: 'https://www.youtube.com/embed/test',
        responseHeaders: {
          'x-frame-options': 'SAMEORIGIN',
          'X-Frame-Options': 'DENY',
          'content-security-policy': ["default-src 'self'; frame-ancestors 'none'; script-src 'self'"]
        }
      },
      (res) => {
        interceptedResponse = res.responseHeaders
      }
    )
    assert.strictEqual(interceptedResponse?.['x-frame-options'], undefined)
    assert.strictEqual(interceptedResponse?.['X-Frame-Options'], undefined)
    const csp = interceptedResponse?.['content-security-policy']
    assert.ok(Array.isArray(csp))
    assert.ok(!csp[0].includes('frame-ancestors'))
    assert.ok(csp[0].includes("default-src 'self'"))
  })

  test('is idempotent per session instance', () => {
    let callCount = 0
    const mockSession = {
      webRequest: {
        onBeforeSendHeaders: () => {
          callCount++
        },
        onHeadersReceived: () => {
          callCount++
        }
      }
    }

    setupMediaHeaders(mockSession)
    assert.strictEqual(callCount, 2)

    setupMediaHeaders(mockSession)
    assert.strictEqual(callCount, 2)
  })
})
