import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * The hourly pass that fills in the rows the migration's bounded hydration
 * did not reach. The route is thin: refuse without the cron secret, refuse
 * when the extension is off, size every usable consent's register on our
 * side, then hand the registers with anything left to the pass smallest
 * first, each with its share of the run, and add the counts up.
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
  countRowlessInvoices: vi.fn(),
}))

import { GET, maxDuration, consentIsUsable } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import {
  completeMigratedInvoiceLines,
  countRowlessInvoices,
} from '@/extensions/general/arcim-migration/lib/complete-invoice-lines'

const mockRegistryGet = vi.mocked(extensionRegistry.get)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockComplete = vi.mocked(completeMigratedInvoiceLines)
const mockCount = vi.mocked(countRowlessInvoices)

const EMPTY = {
  candidates: 0, providerInvoices: 0, matched: 0, unmatched: 0, completed: 0, headersUpdated: 0,
  totalMismatch: 0, noLinesAtProvider: 0, rowsMismatch: 0, notHydrated: 0, vatUnresolved: 0, failed: 0, remaining: 0,
  hydration: { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }, dryRun: false,
}

const DAY_MS = 24 * 60 * 60 * 1000
const RUN_BUDGET_MS = 240_000
const PER_COMPANY_BUDGET_MS = 120_000

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

/** Row-less invoices per company, as the sizing phase finds them. */
function sizes(byCompany: Record<string, number>) {
  mockCount.mockImplementation(async (_supabase, companyId) => byCompany[companyId] ?? 0)
}

/** A pass that completes everything it is given and reports the size it found. */
function completesAll(byCompany: Record<string, number>) {
  mockComplete.mockImplementation(async ({ companyId }) => {
    const n = byCompany[companyId] ?? 0
    return { ...EMPTY, candidates: n, matched: n, completed: n, headersUpdated: n }
  })
}

function makeRequest() {
  return new Request('http://localhost/api/extensions/arcim-migration/complete-invoice-lines/cron', {
    headers: { authorization: 'Bearer synthetic-cron-secret' },
  })
}

/** Freeze the clock so a share is exactly its constant and the run's spend is what the pass says it spent. */
function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-06T10:20:00Z'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCount.mockReset()
  mockComplete.mockReset()
  mockVerifyCronSecret.mockReturnValue(null)
  mockRegistryGet.mockReturnValue({ id: 'arcim-migration' } as never)
  mockCount.mockResolvedValue(0)
  h.consents = { data: [], error: null }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/extensions/arcim-migration/complete-invoice-lines/cron', () => {
  it('reserves the full function window: hydration is rate-limited at the provider', () => {
    expect(maxDuration).toBe(300)
  })

  it('returns 401 when the cron secret is rejected', async () => {
    mockVerifyCronSecret.mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('returns 503 EXTENSION_DISABLED when the extension is not in the registry', async () => {
    mockRegistryGet.mockReturnValue(undefined)

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('EXTENSION_DISABLED')
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('sizes every usable register before the first provider call, then completes them smallest first', async () => {
    // 2026-09-05 on prod: the 1 125-invoice register sat on the newest
    // consent and used two runs in a row; the 384-invoice one three consents
    // older waited both times. Consent age says nothing about work size.
    h.consents = {
      data: [
        consent('c-newest', 'co-big', 0),
        consent('c-mid', 'co-small', 1),
        consent('c-oldest', 'co-medium', 3),
      ],
      error: null,
    }
    const work = { 'co-big': 1125, 'co-small': 155, 'co-medium': 384 }
    sizes(work)
    completesAll(work)

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockCount.mock.calls.map((c) => c[1])).toEqual(['co-big', 'co-small', 'co-medium'])
    expect(mockComplete.mock.calls.map((c) => c[0].companyId)).toEqual(['co-small', 'co-medium', 'co-big'])
    expect(mockComplete.mock.calls.map((c) => c[0].consentId)).toEqual(['c-mid', 'c-oldest', 'c-newest'])
    // Sizing is a separate phase: the last count lands before the first pass.
    expect(Math.max(...mockCount.mock.invocationCallOrder)).toBeLessThan(Math.min(...mockComplete.mock.invocationCallOrder))
    expect(body.data).toMatchObject({
      consents: 3,
      consentsStale: 0,
      consentsFailed: 0,
      companies: 3,
      candidates: 1664,
      completed: 1664,
      skippedForBudget: 0,
      deferred: [],
    })
  })

  it('adds the counts up across the registers it completed', async () => {
    h.consents = {
      data: [
        consent('c-new', 'co-1', 0),
        consent('c-old', 'co-2', 22),
        consent('c-done', 'co-3', 4, 'visma'),
      ],
      error: null,
    }
    sizes({ 'co-1': 311, 'co-2': 384, 'co-3': 0 })
    mockComplete
      .mockResolvedValueOnce({ ...EMPTY, candidates: 311, matched: 311, completed: 300, headersUpdated: 300, notHydrated: 11, remaining: 11 })
      .mockResolvedValueOnce({ ...EMPTY, candidates: 384, matched: 384, completed: 384, headersUpdated: 358 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete).toHaveBeenCalledTimes(2)
    expect(mockComplete.mock.calls[0][0]).toMatchObject({ companyId: 'co-1', consentId: 'c-new' })
    expect(mockComplete.mock.calls[0][0].budgetMs).toBeGreaterThan(0)
    expect(mockComplete.mock.calls[0][0].budgetMs).toBeLessThanOrEqual(PER_COMPANY_BUDGET_MS)
    // The company with nothing to complete is sized, never passed, not counted.
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

  it('skips a register with nothing left: no pass, no provider contact, no budget spent', async () => {
    freezeClock()
    h.consents = {
      data: [consent('c-done', 'co-done', 0), consent('c-todo', 'co-todo', 1)],
      error: null,
    }
    sizes({ 'co-done': 0, 'co-todo': 12 })
    completesAll({ 'co-todo': 12 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockCount).toHaveBeenCalledTimes(2)
    expect(mockComplete).toHaveBeenCalledTimes(1)
    // The register behind it still gets a whole share: sizing cost it nothing.
    expect(mockComplete.mock.calls[0][0]).toMatchObject({
      companyId: 'co-todo', consentId: 'c-todo', budgetMs: PER_COMPANY_BUDGET_MS,
    })
    expect(body.data).toMatchObject({ consents: 2, companies: 1, candidates: 12, completed: 12, skippedForBudget: 0 })
  })

  it('stops at the run deadline and defers what it did not reach, which is the largest registers', async () => {
    freezeClock()
    h.consents = {
      data: [
        consent('c-1', 'co-big', 0),
        consent('c-2', 'co-small', 1),
        consent('c-3', 'co-medium', 2),
      ],
      error: null,
    }
    const work = { 'co-big': 1125, 'co-small': 155, 'co-medium': 384 }
    sizes(work)
    // Each register uses the whole share it is given: two shares fill the run.
    mockComplete.mockImplementation(async ({ companyId, budgetMs }) => {
      vi.setSystemTime(Date.now() + (budgetMs ?? 0))
      const n = work[companyId as keyof typeof work]
      return { ...EMPTY, candidates: n, matched: n, completed: n, headersUpdated: n }
    })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete.mock.calls.map((c) => c[0].companyId)).toEqual(['co-small', 'co-medium'])
    expect(mockComplete.mock.calls.map((c) => c[0].budgetMs)).toEqual([PER_COMPANY_BUDGET_MS, RUN_BUDGET_MS - PER_COMPANY_BUDGET_MS])
    expect(body.data).toMatchObject({
      consents: 3,
      companies: 2,
      candidates: 539,
      skippedForBudget: 1,
      deferred: [{ companyId: 'co-big', candidates: 1125 }],
    })
  })

  it('gives a register reached late the remainder of the run, not a whole share', async () => {
    freezeClock()
    h.consents = {
      data: [consent('c-1', 'co-a', 0), consent('c-2', 'co-b', 1), consent('c-3', 'co-c', 2)],
      error: null,
    }
    const work = { 'co-a': 10, 'co-b': 20, 'co-c': 30 }
    sizes(work)
    // 120 s + 100 s spent: 20 s remain, exactly the minimum worth starting on.
    const spend: Record<string, number> = { 'co-a': 120_000, 'co-b': 100_000, 'co-c': 5_000 }
    mockComplete.mockImplementation(async ({ companyId }) => {
      vi.setSystemTime(Date.now() + spend[companyId])
      const n = work[companyId as keyof typeof work]
      return { ...EMPTY, candidates: n, matched: n, completed: n }
    })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete.mock.calls.map((c) => [c[0].companyId, c[0].budgetMs])).toEqual([
      ['co-a', PER_COMPANY_BUDGET_MS],
      ['co-b', PER_COMPANY_BUDGET_MS],
      ['co-c', 20_000],
    ])
    expect(body.data).toMatchObject({ companies: 3, skippedForBudget: 0 })
  })

  it('isolates a failing count: that consent is reported failed and the others still run', async () => {
    h.consents = {
      data: [consent('c-broken', 'co-broken', 0), consent('c-live', 'co-live', 1)],
      error: null,
    }
    mockCount.mockImplementation(async (_supabase, companyId) => {
      if (companyId === 'co-broken') throw new Error('canceling statement due to statement timeout')
      return 7
    })
    completesAll({ 'co-live': 7 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete.mock.calls.map((c) => c[0].companyId)).toEqual(['co-live'])
    expect(body.data).toMatchObject({ consents: 2, consentsFailed: 1, companies: 1, completed: 7 })
  })

  it('isolates a failing pass: the others still run and the failure is counted', async () => {
    h.consents = {
      data: [consent('c-revoked', 'co-1', 1), consent('c-live', 'co-2', 2)],
      error: null,
    }
    sizes({ 'co-1': 5, 'co-2': 5 })
    mockComplete
      .mockRejectedValueOnce(new Error('Token refresh failed for fortnox; the connection must be re-authorized'))
      .mockResolvedValueOnce({ ...EMPTY, candidates: 5, matched: 5, completed: 5, headersUpdated: 5 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockComplete).toHaveBeenCalledTimes(2)
    // Equal sizes keep the scan order: the newer consent first.
    expect(mockComplete.mock.calls.map((c) => c[0].consentId)).toEqual(['c-revoked', 'c-live'])
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
    sizes({ 'co-1': 1, 'co-2': 1, 'co-3': 1, 'co-4': 1 })
    completesAll({ 'co-2': 1, 'co-3': 1 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    // A dead consent is not even sized: nothing about it can be acted on.
    expect(mockCount.mock.calls.map((c) => c[1])).toEqual(['co-2', 'co-3'])
    expect(mockComplete.mock.calls.map((c) => c[0].consentId)).toEqual(['c-live', 'c-bokio'])
    expect(body.data).toMatchObject({ consents: 2, consentsStale: 2 })
  })

  it('does not page: every usable consent is sized, not only the newest few', async () => {
    // 57 consents were accepted in the last 60 days on prod (2026-09-05); a
    // fixed page of the newest ones would leave older companies with row-less
    // invoices waiting forever behind companies that are already done.
    h.consents = {
      data: Array.from({ length: 80 }, (_, i) => consent(`c-${i}`, `co-${i}`, 1)),
      error: null,
    }
    mockCount.mockResolvedValue(1)
    mockComplete.mockResolvedValue({ ...EMPTY, candidates: 1, matched: 1, completed: 1 })

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockCount).toHaveBeenCalledTimes(80)
    expect(mockComplete).toHaveBeenCalledTimes(80)
    expect(body.data).toMatchObject({ consents: 80, companies: 80, skippedForBudget: 0 })
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
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockComplete).not.toHaveBeenCalled()
  })
})
