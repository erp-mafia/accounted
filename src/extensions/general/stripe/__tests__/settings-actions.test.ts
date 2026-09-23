/**
 * Regression guards for the Stripe settings panel's silent failures.
 *
 * Every assertion below describes something the panel did NOT do before: its
 * click handlers were `try { ... } finally { setSpinner(false) }` with no
 * `catch`, so a rejected fetch produced no toast at all, and its success arm
 * read `data.transactions?.fetched ?? 0`, so a 200 that carried a revoked
 * connection (or a body that never parsed) was reported as a completed sync that
 * "returned no transactions for the period".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  stripeRequest,
  syncSummary,
  serverErrorMessage,
  STRIPE_ACTION_TIMEOUT_MS,
  STRIPE_SYNC_TIMEOUT_MS,
  type StripeSyncPayload,
} from '../lib/settings-actions'

const originalFetch = globalThis.fetch

const SYNC_URL = '/api/extensions/ext/stripe/sync'
const DISCONNECT_URL = '/api/extensions/ext/stripe/disconnect'

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

/** The shape the sync route returns on a healthy run. */
function syncPayload(
  transactions: Partial<NonNullable<StripeSyncPayload['transactions']>>,
): StripeSyncPayload {
  return {
    success: true,
    transactions: {
      fetched: 0,
      imported: 0,
      duplicates: 0,
      linked: 0,
      errors: 0,
      ...transactions,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('stripeRequest', () => {
  it('reports a rejected request as a network failure instead of saying nothing', async () => {
    // The finding: with try/finally and no catch this rejection escaped the
    // handler entirely. The spinner spun, stopped, and no toast was ever shown.
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    const result = await stripeRequest({ url: SYNC_URL })

    expect(result).toEqual({
      ok: false,
      reason: 'network',
      message: 'Något gick fel. Försök igen.',
    })
  })

  it('reports a hung request as a timeout, not as a generic failure', async () => {
    globalThis.fetch = hangingFetch()

    const result = await stripeRequest({ url: SYNC_URL, timeoutMs: 20 })

    // A timeout on a mutation is ambiguous (the write may have landed), so the
    // panel needs it apart from a network failure to say "reload and check".
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('keeps the route own sentence on a 404 rather than the status map', async () => {
    // getErrorMessage alone answers 'Resursen kunde inte hittas.' here, because
    // this sentence carries none of its Swedish trigger words. That is strictly
    // less useful than the route's own copy, which names what to fix.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'Inget anslutet Stripe-konto.' }, 404))

    const result = await stripeRequest({ url: SYNC_URL })

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 404,
      message: 'Inget anslutet Stripe-konto.',
    })
  })

  it('falls back to the status message when the error body carries no sentence', async () => {
    // Previously this branch showed the hardcoded 'Något gick fel. Försök igen.'
    // for every status, so a 429 from the rate limiter and a 502 from a dead
    // upstream read identically.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const result = await stripeRequest({ url: SYNC_URL })

    expect(result).toMatchObject({
      reason: 'server',
      status: 502,
      message: 'Servern är tillfälligt otillgänglig. Försök igen om en stund.',
    })
  })

  it('prefers error_en for an English UI', async () => {
    // capabilityBlockedResponse emits both halves; getErrorMessage only reads
    // message_en inside a structured envelope, so this top-level pair needs
    // handling here or English users get the Swedish sentence.
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: 'Funktionen kräver en aktiv prenumeration.',
          error_en: 'This feature requires an active subscription.',
          capability_blocked: true,
        },
        403,
      ),
    )

    const result = await stripeRequest({ url: SYNC_URL, locale: 'en' })

    expect(result).toMatchObject({
      reason: 'server',
      message: 'This feature requires an active subscription.',
    })
  })

  it('returns the parsed success body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(syncPayload({ fetched: 3, imported: 2 })))

    const result = await stripeRequest<StripeSyncPayload>({ url: SYNC_URL })

    expect(result.ok).toBe(true)
    expect(result.ok && result.data?.transactions?.fetched).toBe(3)
  })

  it('reports success with null data when a 2xx body is not readable JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    const result = await stripeRequest<StripeSyncPayload>({ url: SYNC_URL })

    // Not a failure: the server committed before it flushed headers.
    expect(result).toEqual({ ok: true, data: null })
  })

  it('sends the JSON body and method it is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }))
    globalThis.fetch = fetchMock

    await stripeRequest({
      url: DISCONNECT_URL,
      method: 'DELETE',
      body: { connection_id: 'c0ffee00-0000-4000-8000-000000000001' },
    })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('DELETE')
    expect(init.body).toBe('{"connection_id":"c0ffee00-0000-4000-8000-000000000001"}')
  })

  it('omits the body entirely for the routes that ignore it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }))
    globalThis.fetch = fetchMock

    await stripeRequest({ url: SYNC_URL })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })

  it('bounds every request with an abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }))
    globalThis.fetch = fetchMock

    await stripeRequest({ url: SYNC_URL })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('bounds the sync at the route ceiling, not at the quick-write deadline', async () => {
    // maxDuration is 300 on app/api/extensions/ext/[...path]/route.ts and a first
    // sync backfills 90 days: a 15s abort would report a failure for a run that
    // keeps going server-side and advances the cursor.
    expect(STRIPE_ACTION_TIMEOUT_MS).toBe(15_000)
    expect(STRIPE_SYNC_TIMEOUT_MS).toBeGreaterThan(300_000)
  })
})

describe('serverErrorMessage', () => {
  it('keeps the Swedish sentence for a Swedish UI even when error_en exists', () => {
    expect(
      serverErrorMessage(
        { error: 'Synkroniseringen misslyckades. Försök igen.', error_en: 'Sync failed.' },
        502,
        'sv',
      ),
    ).toBe('Synkroniseringen misslyckades. Försök igen.')
  })

  it('ignores a blank error field', () => {
    expect(serverErrorMessage({ error: '   ' }, 500, 'sv')).toBe(
      'Ett oväntat serverfel uppstod. Försök igen senare.',
    )
  })
})

describe('syncSummary', () => {
  it('reports a revoked connection as a failure, not as an empty window', () => {
    // The regression this exists for: Stripe revoking the connection upstream
    // comes back as a 200 with { revoked: true } and every count at zero, and the
    // panel told the user "Stripe returnerade inga transaktioner för perioden.
    // Kontrollera att rätt konto är anslutet" under a green "Synkronisering
    // klar". The account was right; the connection was gone.
    expect(syncSummary(syncPayload({ revoked: true }))).toEqual({ reason: 'revoked' })
  })

  it('says how many rows failed instead of reading as "all duplicates"', () => {
    // 200 fetched and 0 imported reads as a window full of already-known rows.
    // With errors > 0 it means the opposite: the rows are missing from the inbox.
    expect(syncSummary(syncPayload({ fetched: 200, imported: 0, errors: 200 }))).toEqual({
      reason: 'errors',
      values: { fetched: 200, imported: 0, linked: 0, errors: 200 },
    })
  })

  it('does not call an unreadable body an empty window', () => {
    // `data.transactions?.fetched ?? 0` turned a truncated 2xx into a confident
    // "Stripe returned no transactions", which is a claim about Stripe that the
    // response never made.
    expect(syncSummary(null)).toEqual({ reason: 'unknown' })
    expect(syncSummary({ success: true })).toEqual({ reason: 'unknown' })
    expect(syncSummary({ success: true, transactions: {} })).toEqual({ reason: 'unknown' })
  })

  it('reports a genuinely empty window as empty', () => {
    expect(syncSummary(syncPayload({ fetched: 0 }))).toEqual({ reason: 'empty' })
  })

  it('reports the counts of a healthy run', () => {
    expect(
      syncSummary(syncPayload({ fetched: 12, imported: 9, duplicates: 3, linked: 4 })),
    ).toEqual({ reason: 'feed', values: { fetched: 12, imported: 9, linked: 4 } })
  })
})
