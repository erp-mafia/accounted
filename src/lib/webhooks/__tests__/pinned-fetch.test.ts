import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { pinnedHttpsFetch } from '@/lib/webhooks/pinned-fetch'

// Stand up a minimal stub for node:https.request that captures the args
// we want to assert on (pinned IP, SNI, Host header) and lets us synthesise
// a controlled response back to the caller.
function makeStubRequest(args: {
  status: number
  headers?: Record<string, string>
  body?: string
  emitError?: Error
  emitTimeout?: boolean
}) {
  const captured: {
    options: RequestOptions | null
    bodyWritten: string
  } = { options: null, bodyWritten: '' }

  const fakeRequest = (
    options: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest => {
    captured.options = options

    const req = new EventEmitter() as ClientRequest & EventEmitter
    // ClientRequest API surface we touch in pinned-fetch:
    req.write = ((chunk: string) => {
      captured.bodyWritten += chunk
      return true
    }) as ClientRequest['write']
    req.end = (() => {
      // Dispatch the response (or error) asynchronously to mimic real
      // network timing: pinned-fetch attaches handlers BEFORE end().
      queueMicrotask(() => {
        if (args.emitError) {
          req.emit('error', args.emitError)
          return
        }
        if (args.emitTimeout) {
          req.emit('timeout')
          return
        }
        const res = new EventEmitter() as IncomingMessage & EventEmitter
        ;(res as unknown as { statusCode: number }).statusCode = args.status
        ;(res as unknown as { headers: Record<string, string> }).headers =
          args.headers ?? { 'content-type': 'application/json' }
        // IncomingMessage stubs need stream-shaped methods that pinned-fetch
        // calls (resume on redirect-drain, destroy on size truncation).
        ;(res as unknown as { resume: () => unknown }).resume = () => {
          /* no-op: body is already buffered in args.body */
        }
        ;(res as unknown as { destroy: () => unknown }).destroy = () => {
          // Truncation path: emit `close` so finalize() runs.
          queueMicrotask(() => res.emit('close'))
        }
        callback(res)
        // Emit body bytes then `end`.
        queueMicrotask(() => {
          if (args.body) res.emit('data', Buffer.from(args.body, 'utf8'))
          res.emit('end')
        })
      })
      return req
    }) as ClientRequest['end']
    req.destroy = (() => {
      // no-op: tests don't read the socket after destroy.
      return req
    }) as ClientRequest['destroy']
    req.setTimeout = (() => req) as ClientRequest['setTimeout']

    return req
  }

  return { captured, fakeRequest }
}

function makeStubValidator(addresses: string[]) {
  return vi.fn(async () => ({
    ok: true as const,
    hostname: 'example.com',
    resolvedAddresses: addresses,
  }))
}

describe('pinnedHttpsFetch', () => {
  it('pins the socket to the validated IP while keeping SNI + Host on the hostname', async () => {
    const { captured, fakeRequest } = makeStubRequest({
      status: 200,
      body: 'ok',
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      {
        method: 'POST',
        headers: { 'X-Gnubok-Event': 'invoice.paid' },
        body: '{"hello":"world"}',
        timeoutMs: 1000,
        maxResponseBytes: 1024,
      },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.status).toBe(200)
    expect(result.body).toBe('ok')
    expect(result.pinnedAddress).toBe('203.0.113.42')

    // Socket goes to the IP: DNS does not re-resolve.
    expect(captured.options?.host).toBe('203.0.113.42')
    // SNI carries the hostname so the receiver's TLS cert validates.
    expect(captured.options?.servername).toBe('example.com')
    // HTTP Host header carries the hostname for vhost routing.
    const headers = captured.options?.headers as Record<string, string>
    expect(headers.host).toBe('example.com')
    // Custom dispatcher header survives.
    expect(headers['X-Gnubok-Event']).toBe('invoice.paid')

    expect(captured.bodyWritten).toBe('{"hello":"world"}')
  })

  it('includes the port in the Host header when non-default', async () => {
    const { captured, fakeRequest } = makeStubRequest({ status: 204 })

    await pinnedHttpsFetch(
      'https://example.com:8443/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(captured.options?.port).toBe(8443)
    const headers = captured.options?.headers as Record<string, string>
    expect(headers.host).toBe('example.com:8443')
  })

  it('returns unsafe_url when validation rejects the hostname', async () => {
    const { fakeRequest } = makeStubRequest({ status: 200 })
    const spyRequest = vi.fn(fakeRequest)
    const validator = vi.fn(async () => ({
      ok: false as const,
      reason: 'private_address' as const,
      detail: '10.0.0.1 is private',
    }))

    const result = await pinnedHttpsFetch(
      'https://internal.example/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      { validateUrl: validator, httpsRequest: spyRequest },
    )

    expect(result.kind).toBe('unsafe_url')
    if (result.kind === 'unsafe_url') {
      expect(result.reason).toBe('private_address')
      expect(result.pinnedAddress).toBeNull()
    }
    // Critically: we never opened a socket.
    expect(spyRequest).not.toHaveBeenCalled()
  })

  it('treats 3xx responses as redirect_blocked', async () => {
    const { fakeRequest } = makeStubRequest({
      status: 302,
      headers: { location: 'https://elsewhere.example/' },
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('redirect_blocked')
    if (result.kind === 'redirect_blocked') {
      expect(result.status).toBe(302)
      expect(result.pinnedAddress).toBe('203.0.113.42')
    }
  })

  it('maps transport errors to transport_error', async () => {
    const { fakeRequest } = makeStubRequest({
      status: 0,
      emitError: new Error('ECONNREFUSED 203.0.113.42:443'),
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('transport_error')
    if (result.kind === 'transport_error') {
      expect(result.detail).toContain('ECONNREFUSED')
      expect(result.pinnedAddress).toBe('203.0.113.42')
    }
  })

  it('maps timeout events to timeout', async () => {
    const { fakeRequest } = makeStubRequest({
      status: 0,
      emitTimeout: true,
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('timeout')
  })

  it('truncates response body at maxResponseBytes', async () => {
    const big = 'x'.repeat(10_000)
    const { fakeRequest } = makeStubRequest({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: big,
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 100 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.body.length).toBe(100)
      expect(result.bodyTruncated).toBe(true)
    }
  })

  it('picks the first resolved IP deterministically', async () => {
    const { captured, fakeRequest } = makeStubRequest({ status: 200 })

    await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42', '198.51.100.55']),
        httpsRequest: fakeRequest,
      },
    )

    // First entry, not the second, not random.
    expect(captured.options?.host).toBe('203.0.113.42')
  })
})
