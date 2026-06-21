import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { createClient } from '@/lib/supabase/server'
import { GET } from '../route'

const mockCreateClient = vi.mocked(createClient)

interface AuthShape {
  auth: { getUser: ReturnType<typeof vi.fn> }
  from: ReturnType<typeof vi.fn>
}

function buildSupabase(
  user: { id: string } | null,
  account: { account_number: string; account_name: string } | null,
  linesResult: { data: unknown; error: unknown }
): AuthShape {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'chart_of_accounts') {
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: account, error: null }),
        }
        return chain
      }
      // journal_entry_lines
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        then: (resolve: (v: unknown) => void) => resolve(linesResult),
      }
      return chain
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/reports/trial-balance/account/[accountNumber]/sources', () => {
  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase(null, null, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when fiscal_period_id is missing', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, null, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources'
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when account is unknown for the company', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, null, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/trial-balance/account/9999/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '9999' }))
    expect(res.status).toBe(404)
  })

  it('happy path: returns mapped lines for an account', async () => {
    const linesData = [
      {
        debit_amount: 1250,
        credit_amount: 0,
        journal_entry_id: 'je-1',
        journal_entries: {
          id: 'je-1',
          voucher_number: 7,
          voucher_series: 'A',
          entry_date: '2026-05-02',
          description: 'Provision',
          status: 'posted',
          company_id: 'company-1',
          fiscal_period_id: 'period-1',
        },
      },
      {
        debit_amount: 0,
        credit_amount: 700,
        journal_entry_id: 'je-2',
        journal_entries: {
          id: 'je-2',
          voucher_number: 8,
          voucher_series: 'A',
          entry_date: '2026-05-03',
          description: 'Återbet',
          status: 'posted',
          company_id: 'company-1',
          fiscal_period_id: 'period-1',
        },
      },
    ]
    mockCreateClient.mockResolvedValue(
      buildSupabase(
        { id: 'user-1' },
        { account_number: '1930', account_name: 'Företagskonto' },
        { data: linesData, error: null }
      ) as never
    )

    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        account_number: string
        account_name: string
        lines: Array<{ voucher_number: number; debit: number; credit: number; journal_entry_id: string }>
        next_cursor: string | null
      }
    }

    expect(body.data.account_number).toBe('1930')
    expect(body.data.account_name).toBe('Företagskonto')
    expect(body.data.lines).toHaveLength(2)
    expect(body.data.lines[0].voucher_number).toBe(7)
    expect(body.data.lines[0].debit).toBe(1250)
    expect(body.data.lines[0].journal_entry_id).toBe('je-1')
    expect(body.data.lines[1].credit).toBe(700)
    expect(body.data.next_cursor).toBeNull()
  })

  it('sorts lines by entry_date ASC then voucher_number ASC regardless of DB return order', async () => {
    // DB returns rows in reverse date order (latest first) — the route must
    // sort them, not rely on the database order.
    const linesData = [
      {
        debit_amount: 500,
        credit_amount: 0,
        journal_entry_id: 'je-latest',
        journal_entries: {
          id: 'je-latest',
          voucher_number: 15,
          voucher_series: 'A',
          entry_date: '2026-05-10',
          description: 'Latest',
          status: 'posted',
          company_id: 'company-1',
          fiscal_period_id: 'period-1',
        },
      },
      {
        debit_amount: 200,
        credit_amount: 0,
        journal_entry_id: 'je-earliest',
        journal_entries: {
          id: 'je-earliest',
          voucher_number: 3,
          voucher_series: 'A',
          entry_date: '2026-05-01',
          description: 'Earliest',
          status: 'posted',
          company_id: 'company-1',
          fiscal_period_id: 'period-1',
        },
      },
      {
        debit_amount: 0,
        credit_amount: 100,
        journal_entry_id: 'je-middle',
        journal_entries: {
          id: 'je-middle',
          voucher_number: 9,
          voucher_series: 'A',
          entry_date: '2026-05-05',
          description: 'Middle',
          status: 'posted',
          company_id: 'company-1',
          fiscal_period_id: 'period-1',
        },
      },
    ]

    mockCreateClient.mockResolvedValue(
      buildSupabase(
        { id: 'user-1' },
        { account_number: '1930', account_name: 'Företagskonto' },
        { data: linesData, error: null }
      ) as never
    )

    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: { lines: Array<{ journal_entry_id: string; date: string; voucher_number: number }> }
    }

    expect(body.data.lines).toHaveLength(3)
    expect(body.data.lines[0].journal_entry_id).toBe('je-earliest')  // 2026-05-01, #3
    expect(body.data.lines[1].journal_entry_id).toBe('je-middle')    // 2026-05-05, #9
    expect(body.data.lines[2].journal_entry_id).toBe('je-latest')    // 2026-05-10, #15
  })

  it('sorts lines with same date by voucher_number ASC', async () => {
    const linesData = [
      {
        debit_amount: 100,
        credit_amount: 0,
        journal_entry_id: 'je-high',
        journal_entries: {
          id: 'je-high',
          voucher_number: 20,
          voucher_series: 'A',
          entry_date: '2026-06-01',
          description: 'High voucher',
          status: 'posted',
          company_id: 'company-1',
          fiscal_period_id: 'period-1',
        },
      },
      {
        debit_amount: 50,
        credit_amount: 0,
        journal_entry_id: 'je-low',
        journal_entries: {
          id: 'je-low',
          voucher_number: 5,
          voucher_series: 'A',
          entry_date: '2026-06-01',
          description: 'Low voucher',
          status: 'posted',
          company_id: 'company-1',
          fiscal_period_id: 'period-1',
        },
      },
    ]

    mockCreateClient.mockResolvedValue(
      buildSupabase(
        { id: 'user-1' },
        { account_number: '1930', account_name: 'Företagskonto' },
        { data: linesData, error: null }
      ) as never
    )

    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: { lines: Array<{ journal_entry_id: string }> }
    }

    expect(body.data.lines[0].journal_entry_id).toBe('je-low')   // voucher 5 first
    expect(body.data.lines[1].journal_entry_id).toBe('je-high')  // voucher 20 second
  })
})
