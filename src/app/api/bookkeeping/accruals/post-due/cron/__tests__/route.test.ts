import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

let installmentsResult: {
  data: Array<{ company_id: string }> | null
  error: { message: string } | null
} = { data: [], error: null }

// The route loads company ids through fetchAllRows, which appends
// .range(from, to) per page: the mock slices the fixture so pagination
// (>1000 rows) is exercised for real.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {}
      let from = 0
      let to = Number.MAX_SAFE_INTEGER
      chain.select = vi.fn(() => chain)
      chain.eq = vi.fn(() => chain)
      chain.lte = vi.fn(() => chain)
      chain.order = vi.fn(() => chain)
      chain.range = vi.fn((f: number, t: number) => {
        from = f
        to = t
        return chain
      })
      chain.then = (resolve: (v: unknown) => unknown) => {
        const result = installmentsResult.error
          ? { data: null, error: installmentsResult.error }
          : { data: (installmentsResult.data ?? []).slice(from, to + 1), error: null }
        return Promise.resolve(result).then(resolve)
      }
      return chain
    }),
  })),
}))

const mockPostDueInstallments = vi.fn()
const mockCancelAbandonedDrafts = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  postDueInstallments: (...args: unknown[]) => mockPostDueInstallments(...args),
  cancelAbandonedAccrualDrafts: (...args: unknown[]) => mockCancelAbandonedDrafts(...args),
}))

import { GET } from '../route'
import { createCronRequest } from '@/tests/helpers'

beforeEach(() => {
  vi.clearAllMocks()
  installmentsResult = { data: [], error: null }
  mockCancelAbandonedDrafts.mockResolvedValue({ cancelled: 0, failed: 0, locked: 0 })
})

describe('GET /api/bookkeeping/accruals/post-due/cron', () => {
  it('runs once per distinct company and aggregates results', async () => {
    installmentsResult = {
      data: [
        { company_id: 'company-1' },
        { company_id: 'company-1' },
        { company_id: 'company-2' },
      ],
      error: null,
    }
    mockPostDueInstallments
      .mockResolvedValueOnce({ posted: 2, failed: 0, skipped: 0, errors: [] })
      .mockResolvedValueOnce({ posted: 1, failed: 0, skipped: 0, errors: [] })

    const response = await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))
    const json = await response.json()

    expect(mockPostDueInstallments).toHaveBeenCalledTimes(2)
    expect(mockPostDueInstallments.mock.calls.map((c) => c[1])).toEqual([
      'company-1',
      'company-2',
    ])
    expect(json.success).toBe(true)
    expect(json.total).toBe(2)
    expect(json.succeeded).toBe(2)
    expect(json.not_reached).toBe(0)
    expect(json.results).toEqual([
      { companyId: 'company-1', posted: 2, failed: 0, skipped: 0 },
      { companyId: 'company-2', posted: 1, failed: 0, skipped: 0 },
    ])
  })

  it('paginates past the 1000-row PostgREST cap so no company is starved', async () => {
    // 1000 rows for company-1 fill the first page exactly; company-2's single
    // row only exists on page 2 and would be dropped by an unpaginated select.
    installmentsResult = {
      data: [
        ...Array.from({ length: 1000 }, () => ({ company_id: 'company-1' })),
        { company_id: 'company-2' },
      ],
      error: null,
    }
    mockPostDueInstallments.mockResolvedValue({ posted: 1, failed: 0, skipped: 0, errors: [] })

    const response = await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))
    const json = await response.json()

    expect(json.success).toBe(true)
    expect(mockPostDueInstallments).toHaveBeenCalledTimes(2)
    expect(mockPostDueInstallments.mock.calls.map((c) => c[1])).toEqual([
      'company-1',
      'company-2',
    ])
  })

  it('isolates a failing company so the rest still run', async () => {
    installmentsResult = {
      data: [{ company_id: 'company-1' }, { company_id: 'company-2' }],
      error: null,
    }
    mockPostDueInstallments
      .mockRejectedValueOnce(new Error('database exploded'))
      .mockResolvedValueOnce({ posted: 1, failed: 0, skipped: 0, errors: [] })

    const response = await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))
    const json = await response.json()

    expect(json.success).toBe(true)
    expect(json.succeeded).toBe(1)
    expect(json.failed).toBe(1)
    expect(json.failures).toEqual([{ index: 0, error: 'database exploded' }])
    expect(mockPostDueInstallments).toHaveBeenCalledTimes(2)
  })

  it('hands each company the run deadline, 240 s after the run began', async () => {
    installmentsResult = { data: [{ company_id: 'company-1' }], error: null }
    mockPostDueInstallments.mockResolvedValue({ posted: 1, failed: 0, skipped: 0, errors: [] })
    const before = Date.now()

    await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))

    const options = mockPostDueInstallments.mock.calls[0]![2] as { deadline: number }
    expect(options.deadline).toBeGreaterThanOrEqual(before + 240_000)
    expect(options.deadline).toBeLessThanOrEqual(Date.now() + 240_000)
  })

  it('stops starting companies at the deadline and reports what is left', async () => {
    installmentsResult = {
      data: [{ company_id: 'company-1' }, { company_id: 'company-2' }, { company_id: 'company-3' }],
      error: null,
    }
    // The first company uses up the budget and leaves two of its own months.
    const now = vi.spyOn(Date, 'now')
    mockPostDueInstallments.mockImplementationOnce(async (_supabase, _companyId, options: { deadline: number }) => {
      now.mockReturnValue(options.deadline + 1)
      return { posted: 3, failed: 0, skipped: 0, errors: [], deferred: 2 }
    })

    const response = await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))
    const json = await response.json()
    now.mockRestore()

    // Not started, so not posted and not marked as anything: still pending for the next run.
    expect(mockPostDueInstallments).toHaveBeenCalledTimes(1)
    expect(json).toMatchObject({ total: 3, succeeded: 1, failed: 0, not_reached: 2, months_deferred: 2 })
    expect(json.results).toEqual([{ companyId: 'company-1', posted: 3, failed: 0, skipped: 0 }])
  })

  it('first cancels the drafts killed runs left, in every company, before posting', async () => {
    installmentsResult = { data: [{ company_id: 'company-1' }], error: null }
    const order: string[] = []
    mockCancelAbandonedDrafts.mockImplementation(async () => {
      order.push('sweep')
      return { cancelled: 2, failed: 0, locked: 0 }
    })
    mockPostDueInstallments.mockImplementation(async () => {
      order.push('post')
      return { posted: 1, failed: 0, skipped: 0, errors: [] }
    })

    const response = await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))
    const json = await response.json()

    expect(order).toEqual(['sweep', 'post'])
    // Called once for the run, not per company: it covers companies with no month due today.
    expect(mockCancelAbandonedDrafts).toHaveBeenCalledTimes(1)
    expect(json.abandoned_drafts_cancelled).toBe(2)
  })

  it('posts the months when the look for abandoned drafts fails', async () => {
    installmentsResult = { data: [{ company_id: 'company-1' }], error: null }
    mockCancelAbandonedDrafts.mockRejectedValue(new Error('statement timeout'))
    mockPostDueInstallments.mockResolvedValue({ posted: 1, failed: 0, skipped: 0, errors: [] })

    const response = await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(mockPostDueInstallments).toHaveBeenCalledTimes(1)
    expect(json).toMatchObject({ success: true, abandoned_drafts_cancelled: 0 })
  })

  it('returns 500 when the due query fails', async () => {
    installmentsResult = { data: null, error: { message: 'boom' } }

    const response = await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))

    expect(response.status).toBe(500)
    expect(mockPostDueInstallments).not.toHaveBeenCalled()
  })

  it('rejects unauthorized callers', async () => {
    const { verifyCronSecret } = await import('@/lib/auth/cron')
    const { NextResponse } = await import('next/server')
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(createCronRequest('/api/bookkeeping/accruals/post-due/cron'))

    expect(response.status).toBe(401)
    expect(mockPostDueInstallments).not.toHaveBeenCalled()
  })
})
