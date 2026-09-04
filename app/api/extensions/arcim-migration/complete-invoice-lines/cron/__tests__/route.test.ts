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
      for (const method of ['select', 'eq', 'not', 'gte', 'order']) {
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

import { GET, maxDuration } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { completeMigratedInvoiceLines } from '@/extensions/general/arcim-migration/lib/complete-invoice-lines'

const mockRegistryGet = vi.mocked(extensionRegistry.get)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockComplete = vi.mocked(completeMigratedInvoiceLines)

const EMPTY = {
  candidates: 0, providerInvoices: 0, matched: 0, unmatched: 0, completed: 0, headersUpdated: 0,
  totalMismatch: 0, noLinesAtProvider: 0, notHydrated: 0, vatUnresolved: 0, failed: 0, remaining: 0,
  hydration: { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }, dryRun: false,
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

  it('runs the pass once per recent consent and adds the counts up', async () => {
    h.consents = {
      data: [
        { id: 'c-new', company_id: 'co-1', provider: 'fortnox', created_at: '2026-09-04T13:29:39Z' },
        { id: 'c-old', company_id: 'co-2', provider: 'fortnox', created_at: '2026-08-13T22:58:24Z' },
        { id: 'c-done', company_id: 'co-3', provider: 'visma', created_at: '2026-08-31T17:12:43Z' },
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
      data: [
        { id: 'c-expired', company_id: 'co-1', provider: 'fortnox', created_at: '2026-08-20T00:00:00Z' },
        { id: 'c-live', company_id: 'co-2', provider: 'fortnox', created_at: '2026-08-19T00:00:00Z' },
      ],
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

  it('surfaces a failed consent lookup instead of reporting an empty run', async () => {
    h.consents = { data: null, error: { message: 'relation does not exist' } }

    const response = await GET(makeRequest())

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(mockComplete).not.toHaveBeenCalled()
  })
})
