import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/reports/vat-settlement', () => ({
  buildVatSettlementProposal: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { buildVatSettlementProposal } from '@/lib/reports/vat-settlement'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeProposal() {
  return {
    period: { type: 'quarterly', year: 2026, period: 1, start: '2026-01-01', end: '2026-03-31' },
    period_label: 'Kvartal 1 2026',
    entry_date: '2026-03-31',
    description: 'Momsredovisning Kvartal 1 2026',
    lines: [
      { account_number: '2611', debit_amount: 2500.75, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 1000.5 },
      {
        account_number: '2650', debit_amount: 0, credit_amount: 1500,
        line_description: 'Moms att betala',
      },
      {
        account_number: '3740', debit_amount: 0, credit_amount: 0.25,
        line_description: 'Öres- och kronutjämning',
      },
    ],
    filed_net: 1500,
    rounding_amount: 0.25,
    is_empty: false,
    existing_entries: [],
  }
}

describe('GET /api/reports/vat-declaration/settlement-proposal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    vi.mocked(buildVatSettlementProposal).mockResolvedValue(makeProposal() as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/settlement-proposal?periodType=quarterly&year=2026&period=1',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
    expect(buildVatSettlementProposal).not.toHaveBeenCalled()
  })

  it('returns 400 when period params are missing', async () => {
    const req = new Request('http://localhost/api/reports/vat-declaration/settlement-proposal')
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
    expect(buildVatSettlementProposal).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid period type', async () => {
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/settlement-proposal?periodType=weekly&year=2026&period=1',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
  })

  it('returns 400 for an out-of-range period', async () => {
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/settlement-proposal?periodType=quarterly&year=2026&period=5',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
    expect(buildVatSettlementProposal).not.toHaveBeenCalled()
  })

  it('happy path: returns the proposal', async () => {
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/settlement-proposal?periodType=quarterly&year=2026&period=1',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.filed_net).toBe(1500)
    expect(json.data.lines).toHaveLength(4)
    expect(buildVatSettlementProposal).toHaveBeenCalledWith(
      mockSupabase, 'company-1', 'quarterly', 2026, 1, { fiscalPeriodId: undefined },
    )
  })

  it('forwards the fiscal period for yearly VAT', async () => {
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/settlement-proposal?periodType=yearly&year=2026&period=1&fiscal_period_id=fp-1',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(200)
    expect(buildVatSettlementProposal).toHaveBeenCalledWith(
      mockSupabase, 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' },
    )
  })

  it('returns 500 when the builder fails', async () => {
    vi.mocked(buildVatSettlementProposal).mockRejectedValue(new Error('boom'))
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/settlement-proposal?periodType=quarterly&year=2026&period=1',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error.code).toBe('VAT_REPORT_GENERATION_FAILED')
  })
})
