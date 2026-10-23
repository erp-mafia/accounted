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
  rpc: ReturnType<typeof vi.fn>
}

interface PageRow {
  line_id: string
  debit_amount: number
  credit_amount: number
  dimensions?: Record<string, string> | null
  journal_entry_id: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number
  description: string | null
}

/**
 * The route reads one page through the get_general_ledger_account_page RPC,
 * which returns the account's lines already in report order (the order
 * itself is pinned by tests/pg/ledger-account-days.pg.test.ts). The mock
 * returns the fixture rows as the RPC's `lines` and records its arguments.
 */
function buildSupabase(
  account: { account_number: string; account_name: string } | null,
  rows: PageRow[],
  rpcError: unknown = null,
): SupabaseShape {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'chart_of_accounts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: account, error: null }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
    rpc: vi.fn().mockResolvedValue(
      rpcError ? { data: null, error: rpcError } : { data: { before_debit: 0, before_credit: 0, lines: rows }, error: null },
    ),
  }
}

function row(i: number, overrides: Partial<PageRow> = {}): PageRow {
  return {
    line_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    debit_amount: i + 1,
    credit_amount: 0,
    dimensions: {},
    journal_entry_id: `je-${i}`,
    entry_date: '2026-05-02',
    voucher_series: 'A',
    voucher_number: i + 1,
    description: `Rad ${i}`,
    ...overrides,
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
    authFail(buildSupabase(null, []))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when fiscal_period_id is missing', async () => {
    authOk(buildSupabase(null, []))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources'
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when account is unknown for the company', async () => {
    authOk(buildSupabase(null, []))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/9999/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '9999' }))
    expect(res.status).toBe(404)
  })

  it('returns 400 when the cursor date component is not a structural ISO date', async () => {
    authOk(buildSupabase({ account_number: '1930', account_name: 'Företagskonto' }, []))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1', cursor: 'notadate|5' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when the cursor line id is not a uuid', async () => {
    authOk(buildSupabase({ account_number: '1930', account_name: 'Företagskonto' }, []))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1', cursor: "2026-05-02|5|x' or 1=1" } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBe(400)
  })

  it('happy path: returns mapped lines for an account', async () => {
    const supabase = buildSupabase({ account_number: '1930', account_name: 'Företagskonto' }, [
      row(0, { debit_amount: 1250, journal_entry_id: 'je-1', voucher_number: 7, description: 'Provision' }),
      row(1, { debit_amount: 0, credit_amount: 700, journal_entry_id: 'je-2', voucher_number: 8, entry_date: '2026-05-03', voucher_series: null, dimensions: { '1': 'KS01' } }),
    ])
    authOk(supabase)

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
        lines: Array<Record<string, unknown>>
        next_cursor: string | null
      }
    }

    expect(body.data.account_number).toBe('1930')
    expect(body.data.account_name).toBe('Företagskonto')
    expect(body.data.lines).toEqual([
      { journal_entry_id: 'je-1', voucher_number: 7, voucher_series: 'A', date: '2026-05-02', description: 'Provision', debit: 1250, credit: 0 },
      { journal_entry_id: 'je-2', voucher_number: 8, voucher_series: 'A', date: '2026-05-03', description: 'Rad 1', debit: 0, credit: 700, dimensions: { '1': 'KS01' } },
    ])
    expect(body.data.next_cursor).toBeNull()
    // The whole period, every entry (the drill-down shows what the row sums), one line more than a page.
    expect(supabase.rpc).toHaveBeenCalledWith('get_general_ledger_account_page', expect.objectContaining({
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_account_number: '1930',
      p_from_date: null,
      p_to_date: null,
      p_exclude_entry_id: null,
      p_after_date: null,
      p_limit: 501,
    }))
  })

  it('returns a page of 500 and a cursor at its last line when more follow', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => row(i))
    authOk(buildSupabase({ account_number: '3001', account_name: 'Försäljning' }, rows))

    const req = createMockRequest(
      '/api/reports/trial-balance/account/3001/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '3001' }))
    const body = (await res.json()) as { data: { lines: unknown[]; next_cursor: string | null } }
    expect(body.data.lines).toHaveLength(500)
    expect(body.data.next_cursor).toBe(`2026-05-02|500|${rows[499].line_id}`)
  })

  it('returns no cursor when exactly a page remains', async () => {
    authOk(buildSupabase({ account_number: '3001', account_name: 'Försäljning' }, Array.from({ length: 500 }, (_, i) => row(i))))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/3001/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '3001' }))
    const body = (await res.json()) as { data: { lines: unknown[]; next_cursor: string | null } }
    expect(body.data.lines).toHaveLength(500)
    expect(body.data.next_cursor).toBeNull()
  })

  it('continues after the cursor, and an older two-part cursor after its whole voucher', async () => {
    const supabase = buildSupabase({ account_number: '1930', account_name: 'Företagskonto' }, [])
    authOk(supabase)
    const line = '00000000-0000-4000-8000-000000000042'
    for (const [cursor, lineId] of [[`2026-05-02|41|${line}`, line], ['2026-05-02|41', 'ffffffff-ffff-ffff-ffff-ffffffffffff']]) {
      const req = createMockRequest(
        '/api/reports/trial-balance/account/1930/sources',
        { searchParams: { fiscal_period_id: 'period-1', cursor } }
      )
      const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
      expect(res.status).toBe(200)
      expect(supabase.rpc).toHaveBeenLastCalledWith('get_general_ledger_account_page', expect.objectContaining({
        p_after_date: '2026-05-02', p_after_voucher: 41, p_after_line_id: lineId,
      }))
    }
  })

  it('returns 500 when the page cannot be read', async () => {
    authOk(buildSupabase({ account_number: '1930', account_name: 'Företagskonto' }, [], { code: '57014', message: 'canceling statement due to statement timeout' }))
    const req = createMockRequest(
      '/api/reports/trial-balance/account/1930/sources',
      { searchParams: { fiscal_period_id: 'period-1' } }
    )
    const res = await GET(req, createMockRouteParams({ accountNumber: '1930' }))
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})

describe('GET /api/reports/trial-balance/account/[accountNumber]/sources with a date range', () => {
  const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

  /** Wraps buildSupabase with the fiscal_periods read the range needs. */
  function withPeriod(base: SupabaseShape, period: typeof PERIOD | null): SupabaseShape {
    const inner = base.from as unknown as (table: string) => Record<string, unknown>
    return {
      rpc: base.rpc,
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: period, error: null }),
          }
        }
        return inner(table)
      }),
    }
  }

  const ACCOUNT = { account_number: '1931', account_name: 'Betalkonto' }

  it('limits the lines to the report range', async () => {
    const supabase = withPeriod(buildSupabase(ACCOUNT, []), PERIOD)
    authOk(supabase)

    const req = createMockRequest('/api/reports/trial-balance/account/1931/sources', {
      searchParams: { fiscal_period_id: 'period-1', from_date: '2026-06-01', to_date: '2026-06-30' },
    })
    const res = await GET(req, createMockRouteParams({ accountNumber: '1931' }))
    expect(res.status).toBe(200)
    expect(supabase.rpc).toHaveBeenCalledWith('get_general_ledger_account_page', expect.objectContaining({
      p_from_date: '2026-06-01', p_to_date: '2026-06-30',
    }))
  })

  it('puts no date filter on the lines without a range', async () => {
    const supabase = withPeriod(buildSupabase(ACCOUNT, []), PERIOD)
    authOk(supabase)

    const req = createMockRequest('/api/reports/trial-balance/account/1931/sources', {
      searchParams: { fiscal_period_id: 'period-1' },
    })
    const res = await GET(req, createMockRouteParams({ accountNumber: '1931' }))
    expect(res.status).toBe(200)
    expect(supabase.rpc).toHaveBeenCalledWith('get_general_ledger_account_page', expect.objectContaining({
      p_from_date: null, p_to_date: null,
    }))
  })

  it('returns 400 when the range reaches outside the räkenskapsår', async () => {
    authOk(withPeriod(buildSupabase(ACCOUNT, []), PERIOD))

    const req = createMockRequest('/api/reports/trial-balance/account/1931/sources', {
      searchParams: { fiscal_period_id: 'period-1', from_date: '2025-12-01' },
    })
    const res = await GET(req, createMockRouteParams({ accountNumber: '1931' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the räkenskapsår is not the company\'s', async () => {
    authOk(withPeriod(buildSupabase(ACCOUNT, []), null))

    const req = createMockRequest('/api/reports/trial-balance/account/1931/sources', {
      searchParams: { fiscal_period_id: 'other-period', to_date: '2026-06-30' },
    })
    const res = await GET(req, createMockRouteParams({ accountNumber: '1931' }))
    expect(res.status).toBe(404)
  })
})
