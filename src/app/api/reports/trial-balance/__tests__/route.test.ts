import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateTrialBalance)
const noParams = { params: Promise.resolve({}) }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
const EMPTY = { rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true }

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/reports/trial-balance', { searchParams })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/trial-balance', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(request({}), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns the whole räkenskapsår when no range is given', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(EMPTY)

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      closingEntry: 'include',
      fromDate: undefined,
      toDate: undefined,
    })
  })

  it('passes a date range inside the räkenskapsår to the generator', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(EMPTY)

    const res = await GET(
      request({ period_id: 'period-1', from_date: '2026-06-01', to_date: '2026-06-30' }),
      noParams,
    )
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      closingEntry: 'include',
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
    })
    const { body } = await parseJsonResponse<{ data: typeof EMPTY }>(res)
    expect(body.data).toEqual(EMPTY)
  })

  it('returns 400 when the range reaches outside the räkenskapsår', async () => {
    enqueue({ data: PERIOD })

    const res = await GET(
      request({ period_id: 'period-1', from_date: '2025-12-01', to_date: '2026-06-30' }),
      noParams,
    )
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 when from_date is after to_date', async () => {
    enqueue({ data: PERIOD })

    const res = await GET(
      request({ period_id: 'period-1', from_date: '2026-07-01', to_date: '2026-06-30' }),
      noParams,
    )
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 500 with a message when the generator fails', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockRejectedValue(new Error('boom'))

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(500)
  })
})
