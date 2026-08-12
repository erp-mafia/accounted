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
  mockRequireCapability.mockResolvedValue(null)
  mockHuntCompany.mockResolvedValue({
    companyId: 'co-1',
    candidates: 20,
    poolSize: 5,
    proposed: 2,
    mail: { searched: 8, withCandidates: 3, ingested: 3, candidates: [] },
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

  it('never reports negative work remaining', async () => {
    mockHuntCompany.mockResolvedValue({
      companyId: 'co-1',
      candidates: 3,
      poolSize: 0,
      proposed: 0,
      mail: { searched: 8, withCandidates: 0, ingested: 0, candidates: [] },
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
