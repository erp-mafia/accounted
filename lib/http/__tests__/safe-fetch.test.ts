import { describe, expect, it, vi } from 'vitest'
import {
  isUnsafeUrlError,
  readBodyWithCap,
  safeFetch,
  UnsafeUrlError,
} from '@/lib/http/safe-fetch'
import type { validateWebhookUrl } from '@/lib/webhooks/url-guard'

type Validator = typeof validateWebhookUrl

function okValidator(addresses = ['203.0.113.10']): Validator {
  return vi.fn(async (rawUrl: string) => ({
    ok: true as const,
    hostname: new URL(rawUrl).hostname,
    resolvedAddresses: addresses,
  })) as unknown as Validator
}

function refusingValidator(
  reason: 'private_address' | 'non_https_scheme' | 'metadata_address',
  detail = 'nope',
): Validator {
  return vi.fn(async () => ({ ok: false as const, reason, detail })) as unknown as Validator
}

describe('safeFetch', () => {
  it('validates the hostname, forces redirect: manual and returns the response', async () => {
    const validateUrl = okValidator()
    const response = new Response('ok', { status: 200 })
    const fetchImpl = vi.fn(async () => response)

    const result = await safeFetch(
      'https://shop.example.se/wp-json/',
      { headers: { Accept: 'application/json' } },
      {},
      { validateUrl, fetchImpl },
    )

    expect(result).toBe(response)
    expect(validateUrl).toHaveBeenCalledWith('https://shop.example.se/wp-json/', undefined)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://shop.example.se/wp-json/',
      expect.objectContaining({ redirect: 'manual', headers: { Accept: 'application/json' } }),
    )
  })

  it('refuses a URL whose hostname resolves to a private address without opening a socket', async () => {
    const fetchImpl = vi.fn()

    const error = await safeFetch(
      'https://internal.example/',
      {},
      {},
      { validateUrl: refusingValidator('private_address', '10.0.0.4 is private'), fetchImpl },
    ).catch((e) => e)

    expect(error).toBeInstanceOf(UnsafeUrlError)
    expect(isUnsafeUrlError(error)).toBe(true)
    expect((error as UnsafeUrlError).reason).toBe('private_address')
    expect((error as UnsafeUrlError).detail).toBe('10.0.0.4 is private')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('classifies IP-literal hostnames without DNS (the literal is the only "record")', async () => {
    const fetchImpl = vi.fn()
    const validateUrl = vi.fn(
      async (rawUrl: string, opts?: { resolve4?: (h: string) => Promise<string[]>; resolve6?: (h: string) => Promise<string[]> }) => {
        // Behave like the real validator: consume the injected resolvers.
        const v4 = await opts!.resolve4!(new URL(rawUrl).hostname).catch(() => [])
        const v6 = await opts!.resolve6!(new URL(rawUrl).hostname).catch(() => [])
        return {
          ok: false as const,
          reason: 'metadata_address' as const,
          detail: `resolved ${[...v4, ...v6].join(',')}`,
        }
      },
    ) as unknown as Validator

    const error = await safeFetch(
      'https://169.254.169.254/latest/meta-data/',
      {},
      {},
      { validateUrl, fetchImpl },
    ).catch((e) => e)

    expect((error as UnsafeUrlError).reason).toBe('metadata_address')
    // The literal was handed to the classifier as the v4 answer and v6 had none.
    expect((error as UnsafeUrlError).detail).toBe('resolved 169.254.169.254')
    expect(fetchImpl).not.toHaveBeenCalled()

    // IPv6 literal: brackets are stripped before the family check.
    const validateV6 = vi.fn(
      async (_rawUrl: string, opts?: { resolve4?: (h: string) => Promise<string[]>; resolve6?: (h: string) => Promise<string[]> }) => {
        const v6 = await opts!.resolve6!('x')
        const v4 = await opts!.resolve4!('x').catch((e: NodeJS.ErrnoException) => e.code)
        return { ok: false as const, reason: 'loopback_address' as const, detail: `${v6[0]}|${v4}` }
      },
    ) as unknown as Validator
    const v6Error = await safeFetch('https://[::1]/', {}, {}, { validateUrl: validateV6, fetchImpl }).catch(
      (e) => e,
    )
    expect((v6Error as UnsafeUrlError).detail).toBe('::1|ENODATA')
  })

  it('treats any 3xx as a refusal instead of following it', async () => {
    const cancel = vi.fn(async () => undefined)
    const redirect = {
      status: 302,
      type: 'basic',
      headers: new Headers({ location: 'http://169.254.169.254/' }),
      body: { cancel },
    } as unknown as Response
    const fetchImpl = vi.fn(async () => redirect)

    const error = await safeFetch(
      'https://shop.example.se/',
      {},
      {},
      { validateUrl: okValidator(), fetchImpl },
    ).catch((e) => e)

    expect(isUnsafeUrlError(error)).toBe(true)
    expect((error as UnsafeUrlError).reason).toBe('redirect_blocked')
    expect(cancel).toHaveBeenCalled()
  })

  it('treats an opaque-redirect response as a refusal too', async () => {
    const opaque = { status: 0, type: 'opaqueredirect', headers: new Headers(), body: null } as unknown as Response
    const error = await safeFetch(
      'https://shop.example.se/',
      {},
      {},
      { validateUrl: okValidator(), fetchImpl: vi.fn(async () => opaque) },
    ).catch((e) => e)

    expect((error as UnsafeUrlError).reason).toBe('redirect_blocked')
  })

  it('refuses non-http(s) schemes before validation', async () => {
    const validateUrl = okValidator()
    const error = await safeFetch('file:///etc/passwd', {}, {}, { validateUrl, fetchImpl: vi.fn() }).catch(
      (e) => e,
    )
    expect((error as UnsafeUrlError).reason).toBe('unsupported_scheme')
    expect(validateUrl).not.toHaveBeenCalled()

    const invalid = await safeFetch('not a url', {}, {}, { validateUrl, fetchImpl: vi.fn() }).catch((e) => e)
    expect((invalid as UnsafeUrlError).reason).toBe('invalid_url')
  })

  it('skips the address check for a trusted origin but still refuses its redirects', async () => {
    const validateUrl = refusingValidator('private_address')
    const okResponse = new Response('logo-bytes', { status: 200 })
    const fetchImpl = vi.fn(async () => okResponse)

    const result = await safeFetch(
      'http://192.168.1.50:8000/storage/v1/object/public/logos/a.png',
      {},
      { trustedOrigins: ['http://192.168.1.50:8000/'] },
      { validateUrl, fetchImpl },
    )
    expect(result).toBe(okResponse)
    expect(validateUrl).not.toHaveBeenCalled()

    // Different port is a different origin: back to the strict path.
    const otherPort = await safeFetch(
      'http://192.168.1.50:9000/x.png',
      {},
      { trustedOrigins: ['http://192.168.1.50:8000'] },
      { validateUrl, fetchImpl },
    ).catch((e) => e)
    expect((otherPort as UnsafeUrlError).reason).toBe('private_address')

    // Trusted origin that answers with a redirect is still refused.
    const redirect = { status: 301, type: 'basic', headers: new Headers(), body: null } as unknown as Response
    const bounced = await safeFetch(
      'http://192.168.1.50:8000/storage/v1/object/public/logos/b.png',
      {},
      { trustedOrigins: ['http://192.168.1.50:8000'] },
      { validateUrl, fetchImpl: vi.fn(async () => redirect) },
    ).catch((e) => e)
    expect((bounced as UnsafeUrlError).reason).toBe('redirect_blocked')
  })

  it('lets transport errors propagate unchanged so callers keep their retry semantics', async () => {
    const boom = new TypeError('fetch failed')
    await expect(
      safeFetch('https://shop.example.se/', {}, {}, {
        validateUrl: okValidator(),
        fetchImpl: vi.fn(async () => {
          throw boom
        }),
      }),
    ).rejects.toBe(boom)
  })
})

describe('readBodyWithCap', () => {
  it('returns the bytes when under the cap', async () => {
    const res = new Response(Buffer.from('hello'), { status: 200 })
    const buf = await readBodyWithCap(res, 1024)
    expect(buf?.toString('utf8')).toBe('hello')
  })

  it('rejects on a declared Content-Length over the cap without reading the body', async () => {
    const arrayBuffer = vi.fn()
    const res = {
      headers: new Headers({ 'content-length': String(3 * 1024 * 1024) }),
      body: { cancel: vi.fn(async () => undefined), getReader: vi.fn() },
      arrayBuffer,
    } as unknown as Response

    expect(await readBodyWithCap(res, 2 * 1024 * 1024)).toBeNull()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect((res.body as unknown as { getReader: ReturnType<typeof vi.fn> }).getReader).not.toHaveBeenCalled()
  })

  it('cuts a streamed body off at the cap when the length header is absent or lies', async () => {
    const chunk = new Uint8Array(1024)
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 100) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const res = new Response(stream, { status: 200 })

    expect(await readBodyWithCap(res, 3 * 1024)).toBeNull()
    // Stopped shortly after crossing the cap, not after draining 100 KiB.
    expect(pulls).toBeLessThan(10)
  })

  it('falls back to arrayBuffer() for non-streaming doubles and still applies the cap', async () => {
    const small = {
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response
    expect((await readBodyWithCap(small, 10))?.length).toBe(3)

    const big = {
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array(11).buffer,
    } as unknown as Response
    expect(await readBodyWithCap(big, 10)).toBeNull()
  })
})
