import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

interface SupabaseShape {
  from: ReturnType<typeof vi.fn>
}

function buildSupabase(
  account: { account_number: string; account_name: string } | null,
  linesResult: { data: unknown; error: unknown }
): SupabaseShape {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'chart_of_accounts') {
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: account, error: null }),
        }
        return chain
      }
      // journal_entry_lines: terminates on `.range()` (fetchAllRows), which
      // resolves to the line result. `data.length < PAGE_SIZE` so a single
      // page is fetched.
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        range: vi.fn().mockResolvedValue(linesResult),
        then: (resolve: (v: unknown) => void) => resolve(linesResult),
      }
      return chain
    }),
  }
}

function authOk(supabase: SupabaseShape) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function authFail(supabase: SupabaseShape) {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/reports/trial-balance/account/[accountNumber]/sources', () => {
  it('returns 401 when not authenticated', async () => {
    authFail(buildSupabase(null, { data: [], error: null }))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when fiscal_period_id is missing', async () => {
    authOk(buildSupabase(null, { data: [], error: null }))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources'
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when account is unknown for the company', async () => {
    authOk(buildSupabase(null, { data: [], error: null }))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/9999/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '9999' }))
    expect(res.status).toBe(404)
  })

  it('returns 400 when the cursor date component is not a structural ISO date', async () => {
    // Defense-in-depth (ASVS V1.2): the cursor is applied in JS, but a
    // malformed date component must still be rejected structurally.
    authOk(
      buildSupabase(
        { account_number: '1930', account_name: 'Företagskonto' },
        { data: [], error: null }
      )
    )
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1', cursor: 'notadate|5' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(400)
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
    authOk(
      buildSupabase(
        { account_number: '1930', account_name: 'Företagskonto' },
        { data: linesData, error: null }
      )
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
    // DB returns rows in reverse date order (latest first): the route must
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

    authOk(
      buildSupabase(
        { account_number: '1930', account_name: 'Företagskonto' },
        { data: linesData, error: null }
      )
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

    authOk(
      buildSupabase(
        { account_number: '1930', account_name: 'Företagskonto' },
        { data: linesData, error: null }
      )
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

  it('paginates a >500-line account deterministically regardless of DB return order', async () => {
    // Regression: with no stable parent ORDER BY, a raw `.limit(500)` returned
    // an arbitrary subset that varied between identical requests, the
    // "different rows on every reload" bug for high-volume accounts. We now
    // fetch the full set and sort/slice in JS, so the first page is always the
    // 500 chronologically-earliest lines.
    const total = 600
    const ordered = Array.from({ length: total }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0')
      return {
        debit_amount: i + 1,
        credit_amount: 0,
        journal_entry_id: `je-${String(i).padStart(4, '0')}`,
        journal_entries: {
          id: `je-${String(i).padStart(4, '0')}`,
          voucher_number: i + 1, // unique, monotonic with intended order
          voucher_series: 'A',
          entry_date: `2026-${String((i % 12) + 1).padStart(2, '0')}-${day}`,
          description: `Row ${i}`,
          status: 'posted',
          company_id: 'company-1',
          fiscal_period_id: 'period-1',
        },
      }
    })
    // Shuffle deterministically so the DB "return order" is not the sorted one.
    const shuffled = [...ordered].sort((a, b) =>
      a.journal_entry_id < b.journal_entry_id ? 1 : -1
    )

    authOk(
      buildSupabase(
        { account_number: '3001', account_name: 'Försäljning' },
        { data: shuffled, error: null }
      )
    )

    const req = createMockRequest(
      '/api/reports/trial-balance/account/3001/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '3001' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: { lines: Array<{ voucher_number: number; date: string }>; next_cursor: string | null }
    }

    // First page is exactly PAGE_LIMIT rows, fully sorted (date ASC, then
    // voucher_number ASC, numeric, not lexicographic).
    expect(body.data.lines).toHaveLength(500)
    const lines = body.data.lines
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1]
      const cur = lines[i]
      const ordered =
        prev.date < cur.date ||
        (prev.date === cur.date && prev.voucher_number <= cur.voucher_number)
      expect(ordered).toBe(true)
    }
    // More rows remain → a cursor is returned pointing at the last delivered row.
    expect(body.data.next_cursor).toBe(`${lines[499].date}|${lines[499].voucher_number}`)
  })
})
