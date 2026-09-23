import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  saveKPIPreferences,
  SAVE_KPI_PREFERENCES_TIMEOUT_MS,
} from '@/components/kpi/save-preferences'
import type { KPIPreferences } from '@/types'

const originalFetch = globalThis.fetch

const PREFS: KPIPreferences = {
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

describe('saveKPIPreferences', () => {
  it('PUTs the complete preferences object as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: PREFS }))
    globalThis.fetch = fetchMock

    await saveKPIPreferences({ preferences: PREFS })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/kpi/preferences')
    expect(init.method).toBe('PUT')
    // Every key present: the route treats them all as optional and merges over
    // the stored row, so a sparse body would leave the page rendering keys the
    // server never confirmed.
    expect(JSON.parse(init.body as string)).toEqual(PREFS)
  })

  it('returns the row the route echoed back, not the draft', async () => {
    // The route answers with the merge of the payload over what was stored, so
    // the echo can differ from what was sent. That is the value the page renders.
    const stored: KPIPreferences = {
      visibleKpis: ['netResult', 'cashPosition'],
      kpiOrder: ['cashPosition', 'netResult', 'vatLiability'],
      accountOverrides: { cashPosition: ['1930', '1940'], vatLiability: ['2611'] },
      showMonthlyTable: false,
    }
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ data: stored }))

    const result = await saveKPIPreferences({ preferences: PREFS })

    expect(result).toEqual({ ok: true, preferences: stored })
  })

  it('reports a 500 instead of reporting nothing', async () => {
    // The finding: this branch threw into an empty catch, the dialog closed, and
    // the layout was gone on the next page load.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'Kunde inte spara nyckeltalen. Försök igen.' }, 500))

    const result = await saveKPIPreferences({ preferences: PREFS })

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 500,
      message: 'Kunde inte spara nyckeltalen. Försök igen.',
    })
  })

  it('reports the route validation message on 400', async () => {
    // The account-override validator answers a plain-string envelope; an unknown
    // account number must reach the user, not vanish.
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: 'VALIDATION_ERROR', message: 'Ogiltigt kontonummer i cashPosition.' } },
        400,
      ),
    )

    const result = await saveKPIPreferences({ preferences: PREFS })

    expect(result).toMatchObject({
      ok: false,
      reason: 'server',
      status: 400,
      message: 'Ogiltigt kontonummer i cashPosition.',
    })
  })

  it('falls back to the status message when the error body is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const result = await saveKPIPreferences({ preferences: PREFS })

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 502,
      message: 'Servern är tillfälligt otillgänglig. Försök igen om en stund.',
    })
  })

  it('reports a server error in English for an English UI', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Serverfel' } }, 500))

    const result = await saveKPIPreferences({ preferences: PREFS, locale: 'en' })

    expect(result).toMatchObject({ reason: 'server', message: 'Internal server error.' })
  })

  it('reports a thrown request as a network failure, not as success', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    const result = await saveKPIPreferences({ preferences: PREFS })

    expect(result).toEqual({
      ok: false,
      reason: 'network',
      message: 'Något gick fel. Försök igen.',
    })
  })

  it('reports a hung request as a timeout, not as a generic failure', async () => {
    globalThis.fetch = hangingFetch()

    const result = await saveKPIPreferences({ preferences: PREFS, timeoutMs: 20 })

    // A timeout on a write is ambiguous (the row may have been written), so the
    // dialog needs to tell it apart to say "reload and check".
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('bounds the request with an abort signal on the default deadline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: PREFS }))
    globalThis.fetch = fetchMock

    await saveKPIPreferences({ preferences: PREFS })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Never shorter than the mutation deadline used elsewhere: aborting early
    // reports a failure for a write that may have landed.
    expect(SAVE_KPI_PREFERENCES_TIMEOUT_MS).toBe(15_000)
  })

  it('never yields undefined preferences on a 2xx with no echoed row', async () => {
    // A 200 whose body carries no `data` used to be destructured and assigned
    // straight into the page state, and both the grid and the dialog read
    // .visibleKpis off it without a guard.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}))

    const result = await saveKPIPreferences({ preferences: PREFS })

    expect(result).toEqual({ ok: true, preferences: PREFS })
  })

  it('ignores an echoed row that is not a complete preferences object', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ data: { visibleKpis: null } }))

    const result = await saveKPIPreferences({ preferences: PREFS })

    expect(result).toEqual({ ok: true, preferences: PREFS })
  })
})
