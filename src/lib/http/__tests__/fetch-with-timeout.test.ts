import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchWithTimeout, TimeoutError } from '../fetch-with-timeout'

describe('fetchWithTimeout', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns the response when fetch resolves before the deadline', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    const result = await fetchWithTimeout(
      'https://example.test/',
      { method: 'POST' },
      { timeoutMs: 1000, description: 'test fetch' },
    )

    expect(result).toBe(mockResponse)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('throws TimeoutError when fetch hangs past the timeout', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        signal.addEventListener('abort', () => {
          const reason = (signal as AbortSignal & { reason?: unknown }).reason
          const err = new Error('aborted')
          err.name =
            reason instanceof DOMException ? reason.name : 'AbortError'
          reject(err)
        })
      })
    })

    const start = Date.now()
    await expect(
      fetchWithTimeout(
        'https://example.test/',
        { method: 'POST' },
        { timeoutMs: 50, description: 'slow fetch' },
      ),
    ).rejects.toBeInstanceOf(TimeoutError)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(1000)
  })

  it('includes the description and timeout ms in the error message', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'TimeoutError'
          reject(err)
        })
      })
    })

    try {
      await fetchWithTimeout(
        'https://example.test/',
        { method: 'POST' },
        { timeoutMs: 50, description: 'Fortnox token exchange' },
      )
      expect.fail('expected TimeoutError to be thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError)
      expect((err as Error).name).toBe('TimeoutError')
      expect((err as Error).message).toContain('Fortnox token exchange')
      expect((err as Error).message).toContain('50')
    }
  })

  it('propagates non-timeout errors unchanged', async () => {
    const networkError = new TypeError('fetch failed')
    globalThis.fetch = vi.fn().mockRejectedValue(networkError)

    await expect(
      fetchWithTimeout(
        'https://example.test/',
        { method: 'POST' },
        { timeoutMs: 1000, description: 'test fetch' },
      ),
    ).rejects.toBe(networkError)
  })

  it('honours an external AbortSignal without labelling it a timeout', async () => {
    const externalController = new AbortController()
    globalThis.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted by caller')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const promise = fetchWithTimeout(
      'https://example.test/',
      { method: 'POST', signal: externalController.signal },
      { timeoutMs: 10_000, description: 'caller-cancelable fetch' },
    )

    externalController.abort()

    await expect(promise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error &&
        !(err instanceof TimeoutError) &&
        err.name === 'AbortError',
    )
  })
})
