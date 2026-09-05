import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * The hourly pass that fills in the rows the migration's bounded hydration
 * did not reach. The route is thin: refuse without the cron secret, refuse
 * when the extension is off, then hand each recent accepted consent to the
 * pass with its share of the run and add the counts up.
 */

vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn().mockReturnValue(null) }))

const h = vi.hoisted(() => ({
  consents: { data: [] as unknown[] | null, error: null as { message: string } | null },
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({
    from: vi.fn(() => {
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'not', 'order']) {
        builder[method] = vi.fn(() => builder)
      }
      builder.limit = vi.fn(() => Promise.resolve(h.consents))
      return builder
    }),
  })),
}))

vi.mock('@/extensions/general/arcim-migration/lib/complete-invoice-lines', () => ({
  completeMigratedInvoiceLines: vi.fn(),
}))

import { GET, maxDuration, consentIsUsable } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { completeMigratedInvoiceLines } from '@/extensions/general/arcim-migration/lib/complete-invoice-lines'

const mockRegistryGet = vi.mocked(extensionRegistry.get)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockComplete = vi.mocked(completeMigratedInvoiceLines)

const EMPTY = {
  candidates: 0, providerInvoices: 0, matched: 0, unmatched: 0, completed: 0, headersUpdated: 0,
  totalMismatch: 0, noLinesAtProvider: 0, rowsMismatch: 0, notHydrated: 0, vatUnresolved: 0, failed: 0, remaining: 0,
  hydration: { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }, dryRun: false,
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A consent whose access token expired `daysAgo` days ago (null: never expires). */
function consent(id: string, companyId: string, daysAgo: number | null, provider = 'fortnox') {
  return {
    id,
    company_id: companyId,
    provider,
    created_at: '2026-08-13T22:58:24Z',
    provider_consent_tokens: {
      token_expires_at: daysAgo === null ? null : new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    },
  }
}

function makeRequest() {
  return new Request('http://localhost/api/extensions/arcim-migration/complete-invoice-lines/cron', {
    headers: { authorization: 'Bearer synthetic-cron-secret' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerifyCronSecret.mockReturnValue(null)
  mockRegistryGet.mockReturnValue({ id: 'arcim-migration' } as never)
  h.consents = { data: [], error: null }
})

describe('GET /api/extensions/arcim-migration/complete-invoice-lines/cron', () => {
  it('reserves the full function window: hydration is rate-limited at the provider', () => {
    expect(maxDuration).toBe(300)
  })

  it('returns 401 when the cron secret is rejected', async () => {
    mockVerifyCronSecret.mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('returns 503 EXTENSION_DISABLED when the extension is not in the registry', async () => {
    mockRegistryGet.mockReturnValue(undefined)

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('EXTENSION_DISABLED')
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('runs the pass once per usable consent and adds the counts up', async () => {
    h.consents = {
      data: [
        consent('c-new', 'co-1', 0),
        consent('c-old', 'co-2', 22),
        consent('c-done', 'co-3', 4, 'visma'),
      ],
      error: null,
    }
    mockComplete
      .mockResolvedValueOnce({ ...EMPTY, candidates: 311, matched: 311, completed: 300, headersUpdated: 300, notHydrated: 11, remaining: 11 })
      .mockResolvedValueOnce({ ...EMPTY, candidates: 384, matched: 384, completed: 384, headersUpdated: 358 })
      .mockResolvedValueOnce({ ...EMPTY })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete).toHaveBeenCalledTimes(3)
    expect(mockComplete.mock.calls[0][0]).toMatchObject({ companyId: 'co-1', consentId: 'c-new' })
    expect(mockComplete.mock.calls[0][0].budgetMs).toBeGreaterThan(0)
    expect(mockComplete.mock.calls[0][0].budgetMs).toBeLessThanOrEqual(120_000)
    // The company with nothing to complete is not counted as worked on.
    expect(body.data).toMatchObject({
      consents: 3,
      consentsStale: 0,
      consentsFailed: 0,
      companies: 2,
      candidates: 695,
      completed: 684,
      headersUpdated: 658,
      remaining: 11,
      notHydrated: 11,
      skippedForBudget: 0,
    })
  })

  it('isolates a failing consent: the others still run and the failure is counted', async () => {
    h.consents = {
      data: [consent('c-revoked', 'co-1', 1), consent('c-live', 'co-2', 2)],
      error: null,
    }
    mockComplete
      .mockRejectedValueOnce(new Error('Token refresh failed for fortnox; the connection must be re-authorized'))
      .mockResolvedValueOnce({ ...EMPTY, candidates: 5, matched: 5, completed: 5, headersUpdated: 5 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete).toHaveBeenCalledTimes(2)
    expect(body.data).toMatchObject({ consents: 2, consentsFailed: 1, companies: 1, completed: 5 })
  })

  it('skips consents whose credentials can no longer be refreshed, by token state not consent age', async () => {
    // Fortnox refresh tokens live 45 days and rotate on every refresh: a pair
    // whose access token expired 46 days ago is dead however young the consent
    // row is. A pair refreshed yesterday on a consent from months ago is live.
    // A token without an expiry (Bokio) never goes stale.
    h.consents = {
      data: [
        { ...consent('c-dead', 'co-1', 46), created_at: '2026-09-01T00:00:00Z' },
        { ...consent('c-live', 'co-2', 1), created_at: '2026-04-01T00:00:00Z' },
        consent('c-bokio', 'co-3', null, 'bokio'),
        { ...consent('c-no-token', 'co-4', 1), provider_consent_tokens: null },
      ],
      error: null,
    }
    mockComplete.mockResolvedValue({ ...EMPTY })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete.mock.calls.map((c) => c[0].consentId)).toEqual(['c-live', 'c-bokio'])
    expect(body.data).toMatchObject({ consents: 2, consentsStale: 2 })
  })

  it('does not page: every usable consent is visited, not only the newest few', async () => {
    // 57 consents were accepted in the last 60 days on prod (2026-09-05); a
    // fixed page of the newest ones would leave older companies with row-less
    // invoices waiting forever behind companies that are already done.
    h.consents = {
      data: Array.from({ length: 80 }, (_, i) => consent(`c-${i}`, `co-${i}`, 1)),
      error: null,
    }
    mockComplete.mockResolvedValue({ ...EMPTY })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete).toHaveBeenCalledTimes(80)
    expect(body.data).toMatchObject({ consents: 80, skippedForBudget: 0 })
  })

  it('consentIsUsable reads the token row, tolerating either embed cardinality', () => {
    const now = Date.now()
    const array = { ...consent('c', 'co', 1), provider_consent_tokens: [{ token_expires_at: new Date(now - DAY_MS).toISOString() }] }
    const stale = { ...consent('c', 'co', 1), provider_consent_tokens: [{ token_expires_at: new Date(now - 50 * DAY_MS).toISOString() }] }
    const garbage = { ...consent('c', 'co', 1), provider_consent_tokens: { token_expires_at: 'not a date' } }
    expect(consentIsUsable(array, now)).toBe(true)
    expect(consentIsUsable(stale, now)).toBe(false)
    expect(consentIsUsable(garbage, now)).toBe(false)
    expect(consentIsUsable({ ...consent('c', 'co', 1), provider_consent_tokens: [] }, now)).toBe(false)
  })

  it('surfaces a failed consent lookup instead of reporting an empty run', async () => {
    h.consents = { data: null, error: { message: 'relation does not exist' } }

    const response = await GET(makeRequest())

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(mockComplete).not.toHaveBeenCalled()
  })
})
