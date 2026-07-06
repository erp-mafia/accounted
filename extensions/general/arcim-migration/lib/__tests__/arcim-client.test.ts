import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.stubEnv('ARCIM_SYNC_GATEWAY_URL', 'https://arcim.test.com')
vi.stubEnv('ARCIM_SYNC_API_KEY', 'test-api-key')

import { getConsent, createConsent, fetchCompanyInfo, fetchCustomers } from '../arcim-client'

describe('arcim-client', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    warnSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // Auth & headers
  // -------------------------------------------------------------------------
  describe('request headers', () => {
    it('sends Authorization and Content-Type headers', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'c1', status: 'active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      await getConsent('c1')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [, opts] = fetchSpy.mock.calls[0]
      expect(opts?.headers).toMatchObject({
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
      })
    })
  })

  // -------------------------------------------------------------------------
  // Retry on retryable HTTP status
  // -------------------------------------------------------------------------
  describe('retry', () => {
    it('retries on 503 and succeeds', async () => {
      const fail = new Response('Service Unavailable', { status: 503 })
      const success = new Response(
        JSON.stringify({ id: 'c1', status: 'active' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

      fetchSpy
        .mockResolvedValueOnce(fail)
        .mockResolvedValueOnce(success)

      const result = await getConsent('c1')
      expect(result).toEqual({ id: 'c1', status: 'active' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('returned 503, retrying')
      )
    })

    it('retries on 429 (rate limit) and succeeds', async () => {
      const rateLimit = new Response('Too Many Requests', { status: 429 })
      const success = new Response(
        JSON.stringify({ id: 'c1', status: 'active' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

      fetchSpy
        .mockResolvedValueOnce(rateLimit)
        .mockResolvedValueOnce(success)

      const result = await getConsent('c1')
      expect(result).toEqual({ id: 'c1', status: 'active' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('retries on 502 and 504 as well', async () => {
      const bad502 = new Response('Bad Gateway', { status: 502 })
      const bad504 = new Response('Gateway Timeout', { status: 504 })
      const success = new Response(
        JSON.stringify({ id: 'c1', status: 'active' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

      fetchSpy
        .mockResolvedValueOnce(bad502)
        .mockResolvedValueOnce(bad504)
        .mockResolvedValueOnce(success)

      const result = await getConsent('c1')
      expect(result).toEqual({ id: 'c1', status: 'active' })
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('throws after exhausting all retries on retryable status', async () => {
      const fail = new Response('Service Unavailable', { status: 503 })

      fetchSpy
        .mockResolvedValueOnce(fail.clone())
        .mockResolvedValueOnce(fail.clone())
        .mockResolvedValueOnce(fail.clone())

      await expect(getConsent('c1')).rejects.toThrow('Arcim API 503')
      expect(fetchSpy).toHaveBeenCalledTimes(3) // 1 original + 2 retries
    })

    it('does not retry on 400 errors', async () => {
      const badRequest = new Response('Bad Request', { status: 400 })
      fetchSpy.mockResolvedValueOnce(badRequest)

      await expect(getConsent('c1')).rejects.toThrow('Arcim API 400')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('does not retry on 404 errors', async () => {
      const notFound = new Response('Not Found', { status: 404 })
      fetchSpy.mockResolvedValueOnce(notFound)

      await expect(getConsent('c1')).rejects.toThrow('Arcim API 404')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // Retry on timeout (AbortError)
  // -------------------------------------------------------------------------
  describe('timeout retry', () => {
    it('retries on AbortError and succeeds', async () => {
      const abortError = new DOMException('Aborted', 'AbortError')
      const success = new Response(
        JSON.stringify({ id: 'c1', status: 'active' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

      fetchSpy
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce(success)

      const result = await getConsent('c1')
      expect(result).toEqual({ id: 'c1', status: 'active' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('timed out, retrying')
      )
    })

    it('throws timeout error after exhausting retries on AbortError', async () => {
      const abortError = new DOMException('Aborted', 'AbortError')

      fetchSpy
        .mockRejectedValueOnce(abortError)
        .mockRejectedValueOnce(abortError)
        .mockRejectedValueOnce(abortError)

      await expect(getConsent('c1')).rejects.toThrow('Arcim API timeout')
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('does not retry on non-abort network errors', async () => {
      const networkError = new TypeError('fetch failed')
      fetchSpy.mockRejectedValueOnce(networkError)

      await expect(getConsent('c1')).rejects.toThrow('fetch failed')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // Exponential backoff
  // -------------------------------------------------------------------------
  describe('backoff', () => {
    it('increases delay on successive retries', async () => {
      const delays: number[] = []
      const realSetTimeout = globalThis.setTimeout
      // Only intercept retry delays (1000-10000ms range), pass abort timers through
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
        if (ms && ms >= 1000 && ms < 120_000) {
          delays.push(ms as number)
          // Execute retry delay callback immediately
          if (typeof fn === 'function') fn()
          return 0 as unknown as ReturnType<typeof setTimeout>
        }
        // Let abort controller timers run through real setTimeout
        return realSetTimeout(fn, ms)
      })

      const fail = new Response('Service Unavailable', { status: 503 })
      const success = new Response(
        JSON.stringify({ id: 'c1', status: 'active' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

      fetchSpy
        .mockResolvedValueOnce(fail.clone())
        .mockResolvedValueOnce(fail.clone())
        .mockResolvedValueOnce(success)

      await getConsent('c1')

      // attempt 0 → delay = 1000 * (0+1) = 1000
      // attempt 1 → delay = 1000 * (1+1) = 2000
      expect(delays).toEqual([1000, 2000])

      vi.restoreAllMocks()
      // Re-set our spies since restoreAllMocks clears them
      fetchSpy = vi.spyOn(globalThis, 'fetch')
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
  })

  // -------------------------------------------------------------------------
  // POST body
  // -------------------------------------------------------------------------
  describe('request body', () => {
    it('sends JSON body for POST requests', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'c1', status: 'pending', provider: 'fortnox' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )

      await createConsent('fortnox' as any, 'Test', '5591234567', 'Test AB')

      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toBe('https://arcim.test.com/api/v1/consents')
      expect(opts?.method).toBe('POST')
      expect(JSON.parse(opts?.body as string)).toEqual({
        name: 'Test',
        provider: 'fortnox',
        orgNumber: '5591234567',
        companyName: 'Test AB',
      })
    })
  })

  // -------------------------------------------------------------------------
  // Pagination (fetchAllPages)
  // -------------------------------------------------------------------------
  describe('pagination', () => {
    it('fetches all pages until hasMore is false', async () => {
      const page1 = { data: [{ id: 'c1' }, { id: 'c2' }], hasMore: true }
      const page2 = { data: [{ id: 'c3' }], hasMore: false }

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page1), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )

      const result = await fetchCustomers('consent-1')
      expect(result).toHaveLength(3)
      expect(result.map((c: any) => c.id)).toEqual(['c1', 'c2', 'c3'])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('stops when page returns empty data', async () => {
      const page1 = { data: [{ id: 'c1' }], hasMore: true }
      const page2 = { data: [], hasMore: true }

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page1), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )

      const result = await fetchCustomers('consent-1')
      expect(result).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // Singleton resource (fetchCompanyInfo)
  // -------------------------------------------------------------------------
  describe('singleton resource', () => {
    it('unwraps { data } envelope for company info', async () => {
      const company = { orgNumber: '5591234567', name: 'Test AB' }
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: company }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      const result = await fetchCompanyInfo('consent-1')
      expect(result).toEqual(company)
    })

    it('returns null when data is undefined', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      const result = await fetchCompanyInfo('consent-1')
      expect(result).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Missing env vars
  // -------------------------------------------------------------------------
  describe('environment validation', () => {
    it('throws when ARCIM_SYNC_GATEWAY_URL is missing', async () => {
      const orig = process.env.ARCIM_SYNC_GATEWAY_URL
      delete process.env.ARCIM_SYNC_GATEWAY_URL

      try {
        await expect(getConsent('c1')).rejects.toThrow(
          'ARCIM_SYNC_GATEWAY_URL is not configured'
        )
      } finally {
        process.env.ARCIM_SYNC_GATEWAY_URL = orig
      }
    })

    it('throws when ARCIM_SYNC_API_KEY is missing', async () => {
      const orig = process.env.ARCIM_SYNC_API_KEY
      delete process.env.ARCIM_SYNC_API_KEY

      try {
        await expect(getConsent('c1')).rejects.toThrow(
          'ARCIM_SYNC_API_KEY is not configured'
        )
      } finally {
        process.env.ARCIM_SYNC_API_KEY = orig
      }
    })
  })
})
