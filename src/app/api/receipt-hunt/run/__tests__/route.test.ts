/**
 * The button's route. What matters is that it cannot run for someone who is not
 * signed in, cannot run without the tier that reads PDFs, and reports enough
 * for a person to decide whether to press again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockHuntCompany = vi.fn()
vi.mock('@/lib/receipt-hunt/hunt', () => ({
  huntCompany: (...args: unknown[]) => mockHuntCompany(...args),
}))

const mockRequireCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({}),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

// No Redis unless a test provides one: then the pass slot is not claimed and
// the daily budget is not counted, exactly the local and self-hosted shape.
let redis: { set: ReturnType<typeof vi.fn>; eval: ReturnType<typeof vi.fn> } | null = null
const mockCheckRateLimit = vi.fn()
vi.mock('@/lib/auth/rate-limit-http', () => ({
  getRedis: () => redis,
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

const context = {
  requestId: 'req-1',
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => context.log) },
  user: { id: 'user-1' },
  supabase: {},
  companyId: 'co-1',
}

let unauthorized = false
vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext: (_op: string, handler: (req: unknown, ctx: unknown) => unknown) => {
    return async (req: unknown) => {
      if (unauthorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      }
      return handler(req, context)
    }
  },
}))

import { POST } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  unauthorized = false
  redis = null
  mockCheckRateLimit.mockResolvedValue({ ok: true })
  mockRequireCapability.mockResolvedValue(null)
  mockHuntCompany.mockResolvedValue({
    companyId: 'co-1',
    candidates: 20,
    poolSize: 5,
    proposed: 2,
    mail: { searchable: 20, searched: 8, withCandidates: 3, ingested: 3, candidates: [] },
  })
})

describe('POST /api/receipt-hunt/run', () => {
  it('refuses an unauthenticated caller', async () => {
    unauthorized = true
    const response = await POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)
    expect(response.status).toBe(401)
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('refuses a company without the tier that reads PDFs', async () => {
    // Fetching receipts nobody can extract an amount from would file documents
    // that can never pair: worse than not running.
    mockRequireCapability.mockResolvedValue(
      new Response(JSON.stringify({ error: 'capability_blocked' }), { status: 402 }),
    )
    const response = await POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)
    expect(response.status).toBe(402)
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('searches the mailboxes, which the nightly run still does not', async () => {
    await POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)
    const [, , , options] = mockHuntCompany.mock.calls[0]
    expect(options.searchMail).toBe(true)
  })

  it('bounds the pass so one press cannot run past the function timeout', async () => {
    await POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)
    const [, , , options] = mockHuntCompany.mock.calls[0]
    expect(options.mailSearchLimit).toBeGreaterThan(0)
    expect(options.maxReceipts).toBeGreaterThan(0)
  })

  it('reports what is left, so pressing again is an informed choice', async () => {
    const response = await POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)
    const { body } = await parseJsonResponse<{
      data: { searched: number; fetched: number; proposed: number; remaining: number }
    }>(response)

    expect(body.data).toMatchObject({ searched: 8, fetched: 3, proposed: 2 })
    // 20 purchases without a receipt, 8 looked at.
    expect(body.data.remaining).toBe(12)
  })

  it('never counts purchases the search does not look for as left', async () => {
    // 30 purchases lack a receipt, but 10 are salary and tax runs, which no
    // mailbox holds a receipt for and the search skips.
    mockHuntCompany.mockResolvedValue({
      companyId: 'co-1',
      candidates: 30,
      poolSize: 0,
      proposed: 0,
      mail: { searchable: 20, searched: 8, withCandidates: 0, ingested: 0, candidates: [] },
    })
    const response = await POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)
    const { body } = await parseJsonResponse<{ data: { remaining: number; purchasesWithoutReceipt: number } }>(
      response,
    )
    expect(body.data.remaining).toBe(12)
    expect(body.data.purchasesWithoutReceipt).toBe(30)
  })

  it('never reports negative work remaining', async () => {
    mockHuntCompany.mockResolvedValue({
      companyId: 'co-1',
      candidates: 3,
      poolSize: 0,
      proposed: 0,
      mail: { searchable: 3, searched: 8, withCandidates: 0, ingested: 0, candidates: [] },
    })
    const response = await POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)
    const { body } = await parseJsonResponse<{ data: { remaining: number } }>(response)
    expect(body.data.remaining).toBe(0)
  })

  it('survives a company with no mailbox connected', async () => {
    // getMailSearchService falls back to a no-op, so the mail leg is absent
    // rather than failing.
    mockHuntCompany.mockResolvedValue({
      companyId: 'co-1',
      candidates: 4,
      poolSize: 2,
      proposed: 1,
    })
    const response = await POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)
    const { body } = await parseJsonResponse<{ data: { searched: number; fetched: number } }>(
      response,
    )
    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({ searched: 0, fetched: 0 })
  })
})

describe('POST /api/receipt-hunt/run: one pass at a time, and a daily budget', () => {
  const run = () => POST(createMockRequest('http://localhost/api/receipt-hunt/run'), undefined as never)

  it('answers 409 while another pass holds the company, and does not hunt', async () => {
    redis = { set: vi.fn().mockResolvedValue(null), eval: vi.fn() }

    const response = await run()

    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('RECEIPT_HUNT_IN_PROGRESS')
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('claims the slot for the company with an expiry and frees it after the pass', async () => {
    redis = { set: vi.fn().mockResolvedValue('OK'), eval: vi.fn().mockResolvedValue(1) }

    const response = await run()

    expect(response.status).toBe(200)
    const [key, runId, options] = redis.set.mock.calls[0]
    expect(key).toBe('receipt-hunt:lease:co-1')
    expect(options).toMatchObject({ nx: true })
    expect(options.px).toBeGreaterThan(300_000)
    // Compare-and-delete with this run's id, so a later run's slot survives.
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), ['receipt-hunt:lease:co-1'], [runId])
  })

  it('frees the slot even when the pass throws', async () => {
    redis = { set: vi.fn().mockResolvedValue('OK'), eval: vi.fn().mockResolvedValue(1) }
    mockHuntCompany.mockRejectedValue(new Error('gmail down'))

    await expect(run()).rejects.toThrow('gmail down')
    expect(redis.eval).toHaveBeenCalledTimes(1)
  })

  it('answers the limiter 429 once the day is spent, frees the slot and does not hunt', async () => {
    redis = { set: vi.fn().mockResolvedValue('OK'), eval: vi.fn().mockResolvedValue(1) }
    mockCheckRateLimit.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'För många förfrågningar. Försök igen om en stund.' }), { status: 429 }),
    })

    const response = await run()

    expect(response.status).toBe(429)
    expect(mockHuntCompany).not.toHaveBeenCalled()
    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'co-1', maxRequests: 40, windowMs: 86_400_000 }),
    )
  })
})
