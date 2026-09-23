import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  loadKPIPreferences,
  LOAD_KPI_PREFERENCES_TIMEOUT_MS,
} from '@/components/kpi/load-preferences'
import type { KPIPreferences } from '@/types'

const originalFetch = globalThis.fetch

const STORED: KPIPreferences = {
  visibleKpis: ['netResult', 'cashPosition'],
  kpiOrder: ['cashPosition', 'netResult', 'vatLiability'],
  accountOverrides: { cashPosition: ['1930', '1940'] },
  showMonthlyTable: true,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A fetch that never resolves and rejects the way the platform does on abort. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted due to timeout')
        err.name = 'TimeoutError'
        reject(err)
      })
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('loadKPIPreferences', () => {
  it('GETs the preferences endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: STORED }))
    globalThis.fetch = fetchMock

    await loadKPIPreferences()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/kpi/preferences')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  it('returns the stored row the route answered with', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ data: STORED }))

    const result = await loadKPIPreferences()

    expect(result).toEqual({ ok: true, preferences: STORED })
  })

  it('reports a 401 as a server failure carrying the status-map sentence', async () => {
    // The page reads status 401/403 off this arm to drop the retry: a retry
    // cannot outlive an expired session, signing in again can.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }))

    const result = await loadKPIPreferences()

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 401,
      message: 'Din session har gått ut. Logga in igen.',
    })
  })

  it('reports a 403 with its status so the page can drop the retry', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 403 }))

    const result = await loadKPIPreferences()

    expect(result).toMatchObject({ ok: false, reason: 'server', status: 403 })
  })

  it('reports a 500 as a failure instead of fabricating defaults', async () => {
    // The finding: this arm used to fall into a silent catch, the page seeded
    // the settings dialog from getDefaultPreferences(), and the next save PUT
    // that defaults-based object over the user's stored layout. The terse
    // envelope message is not Swedish user-prose, so getErrorMessage resolves
    // it through the status map.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Serverfel' } }, 500))

    const result = await loadKPIPreferences()

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 500,
      message: 'Ett oväntat serverfel uppstod. Försök igen senare.',
    })
  })

  it('falls back to the status message when the error body is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const result = await loadKPIPreferences()

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 502,
      message: 'Servern är tillfälligt otillgänglig. Försök igen om en stund.',
    })
  })

  it('reports a server error in English for an English UI', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }))

    const result = await loadKPIPreferences({ locale: 'en' })

    expect(result).toMatchObject({
      reason: 'server',
      message: 'Your session has expired. Please sign in again.',
    })
  })

  it('reports a thrown request as a network failure, not as defaults', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    const result = await loadKPIPreferences()

    expect(result).toEqual({
      ok: false,
      reason: 'network',
      message: 'Något gick fel. Försök igen.',
    })
  })

  it('reports a hung request as a timeout instead of hanging the page', async () => {
    globalThis.fetch = hangingFetch()

    const result = await loadKPIPreferences({ timeoutMs: 20 })

    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('bounds the request with an abort signal on the default deadline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: STORED }))
    globalThis.fetch = fetchMock

    await loadKPIPreferences()

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(LOAD_KPI_PREFERENCES_TIMEOUT_MS).toBe(15_000)
  })

  it('treats a 200 without a preferences object as a failed read, never as defaults', async () => {
    // Unlike the save path (where a 2xx means the row was already written and
    // the sent payload is the closest truth), a read has nothing truthful to
    // substitute: an ok result here would flow into the dialog draft and be
    // saved over the stored row.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}))

    const result = await loadKPIPreferences()

    expect(result).toMatchObject({ ok: false, reason: 'network' })
  })

  it('treats a 200 with an incomplete preferences object as a failed read', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ data: { visibleKpis: null } }))

    const result = await loadKPIPreferences()

    expect(result).toMatchObject({ ok: false, reason: 'network' })
  })

  it('treats a 200 whose body is not JSON as a failed read', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<!doctype html><title>proxy</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const result = await loadKPIPreferences()

    expect(result).toMatchObject({ ok: false, reason: 'network' })
  })
})
