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

vi.mock('@/lib/reports/general-ledger', () => ({
  generateGeneralLedger: vi.fn(),
}))

import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateGeneralLedger)

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

// Next.js 16 static-route second arg
const noParams = { params: Promise.resolve({}) }

const EMPTY_REPORT = {
  accounts: [],
  period: { start: '2026-01-01', end: '2026-12-31' },
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
})

describe('GET /api/reports/general-ledger', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const res = await GET(createMockRequest('/api/reports/general-ledger'), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(createMockRequest('/api/reports/general-ledger'), noParams)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a malformed from_date', async () => {
    enqueue({ data: PERIOD }) // fiscal_periods
    const res = await GET(
      createMockRequest('/api/reports/general-ledger', {
        searchParams: { period_id: 'period-1', from_date: '2026-6-1' },
      }),
      noParams
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 when the range falls outside the fiscal period', async () => {
    enqueue({ data: PERIOD }) // fiscal_periods
    const res = await GET(
      createMockRequest('/api/reports/general-ledger', {
        searchParams: { period_id: 'period-1', from_date: '2025-06-01' },
      }),
      noParams
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('passes the validated date range through to the generator', async () => {
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue({
      ...EMPTY_REPORT,
      period: { start: '2026-06-01', end: '2026-06-30' },
    })

    const res = await GET(
      createMockRequest('/api/reports/general-ledger', {
        searchParams: {
          period_id: 'period-1',
          from_date: '2026-06-01',
          to_date: '2026-06-30',
        },
      }),
      noParams
    )
    const { status, body } = await parseJsonResponse<{ data: typeof EMPTY_REPORT }>(res)
    expect(status).toBe(200)
    expect(body.data.period).toEqual({ start: '2026-06-01', end: '2026-06-30' })
    expect(mockGenerate).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
      undefined,
      undefined,
      expect.objectContaining({ fromDate: '2026-06-01', toDate: '2026-06-30' })
    )
  })

  it('omits the range when no date params are sent (full period)', async () => {
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue(EMPTY_REPORT)

    const res = await GET(
      createMockRequest('/api/reports/general-ledger', {
        searchParams: { period_id: 'period-1' },
      }),
      noParams
    )
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
      undefined,
      undefined,
      expect.objectContaining({ fromDate: undefined, toDate: undefined })
    )
  })
})
