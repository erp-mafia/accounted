/**
 * Tests for POST /api/import/documents/preview: the read-only match plan that
 * pairs underlag filenames with SIE-migrated verifikat before anything is
 * uploaded or linked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { UnderlagPlan } from '@/lib/documents/underlag-import'

const PERIOD_OPEN = '33333333-3333-4333-8333-333333333333'

const PERIODS = [
  {
    id: PERIOD_OPEN,
    period_start: '2024-01-01',
    period_end: '2024-12-31',
    is_closed: false,
    locked_at: null,
  },
]

let vouchers: Record<string, unknown>[] = []
/** The row the fiscal-period ownership lookup finds, or null for "not ours". */
let ownedPeriod: Record<string, unknown> | null = null

/** Shape-keyed double: the plan reads vouchers and periods concurrently. */
const supabase = {
  from(table: string) {
    let filteredByNumber = false
    let single = false
    const result = () => {
      if (table === 'fiscal_periods') {
        return single
          ? { data: ownedPeriod, error: null }
          : { data: PERIODS, error: null, count: PERIODS.length }
      }
      return {
        data: filteredByNumber ? vouchers : [],
        error: null,
        count: vouchers.length,
      }
    }

    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'not', 'order', 'limit', 'single']) {
      chain[method] = () => chain
    }
    chain.maybeSingle = () => {
      single = true
      return chain
    }
    chain.in = () => {
      filteredByNumber = true
      return chain
    }
    chain.range = () => Promise.resolve(result())
    chain.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(result()).then(onFulfilled)
    return chain
  },
}

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

// Guideline mock: no real Supabase client may ever be constructed in a route
// test, even though this suite injects its double through requireAuth.
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(supabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

function makeRequest(body: Record<string, unknown>) {
  return createMockRequest('/api/import/documents/preview', {
    method: 'POST',
    body: { fiscal_period_id: PERIOD_OPEN, ...body },
  })
}

describe('POST /api/import/documents/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vouchers = [
      {
        id: 'je-1',
        fiscal_period_id: PERIOD_OPEN,
        entry_date: '2024-03-14',
        description: 'Inköp kontorsmaterial',
        voucher_series: 'A',
        voucher_number: 47,
        source_voucher_series: 'A',
        source_voucher_number: 31,
      },
    ]
    ownedPeriod = { id: PERIOD_OPEN }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await POST(makeRequest({ file_names: ['A31.pdf'] }), emptyParams)

    expect(res.status).toBe(401)
  })

  it('returns 400 when file_names is missing or empty', async () => {
    expect((await POST(makeRequest({}), emptyParams)).status).toBe(400)
    expect((await POST(makeRequest({ file_names: [] }), emptyParams)).status).toBe(400)
  })

  it('returns 400 without a fiscal year: a filename alone cannot identify a verifikat', async () => {
    const noYear = createMockRequest('/api/import/documents/preview', {
      method: 'POST',
      body: { file_names: ['A31.pdf'] },
    })
    expect((await POST(noYear, emptyParams)).status).toBe(400)

    const badYear = await POST(
      makeRequest({ file_names: ['A31.pdf'], fiscal_period_id: 'not-a-uuid' }),
      emptyParams,
    )
    expect(badYear.status).toBe(400)
  })

  it("returns 404 for a fiscal year that is not this company's", async () => {
    ownedPeriod = null

    const res = await POST(makeRequest({ file_names: ['A31.pdf'] }), emptyParams)

    expect(res.status).toBe(404)
  })

  it('returns 400 when the batch exceeds the 2000-file cap', async () => {
    const oversized = Array.from({ length: 2001 }, (_, i) => `A${i + 1}.pdf`)

    const res = await POST(makeRequest({ file_names: oversized }), emptyParams)

    expect(res.status).toBe(400)
  })

  it('returns the match plan for the submitted filenames (happy path)', async () => {
    const res = await POST(
      makeRequest({ file_names: ['A31_8c2db060.pdf', 'kvitto.pdf'] }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<{ data: UnderlagPlan }>(res)

    expect(status).toBe(200)
    expect(body.data.rows).toHaveLength(2)
    expect(body.data.rows[0]).toMatchObject({ status: 'matched', journal_entry_id: 'je-1' })
    expect(body.data.rows[1]).toMatchObject({ status: 'unparsed', journal_entry_id: null })
    expect(body.data.summary).toMatchObject({ total: 2, matched: 1, unparsed: 1 })
  })

  it('never returns a target the filename does not name', async () => {
    const res = await POST(makeRequest({ file_names: ['A99.pdf'] }), emptyParams)
    const { body } = await parseJsonResponse<{ data: UnderlagPlan }>(res)

    expect(body.data.rows[0].status).toBe('no_match')
    expect(body.data.rows[0].journal_entry_id).toBeNull()
  })
})
