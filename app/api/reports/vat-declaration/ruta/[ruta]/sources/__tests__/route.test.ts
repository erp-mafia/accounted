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
import { resolvePeriodDates } from '@/lib/reports/vat-declaration'

interface SupabaseShape {
  from: ReturnType<typeof vi.fn>
  rpc: ReturnType<typeof vi.fn>
}

/**
 * `fiscalPeriodResult` is what a `fiscal_periods` lookup resolves to: both the
 * explicit-id lookup and the "räkenskapsår ending in `year`" lookup that
 * `resolvePeriodDates` performs for helårsmoms.
 */
function buildSupabase(
  linesResult: { data: unknown; error: unknown },
  fiscalPeriodResult: { data: unknown; error: unknown } = { data: null, error: null },
  chartAccounts: Array<{
    account_number: string
    account_name?: string
    account_class?: number
    default_vat_rate: number | null
    default_vat_treatment?: string | null
  }> = []
): SupabaseShape {
  const chartResult = {
    data: chartAccounts.map((account) => ({
      account_class: 3,
      default_vat_treatment: null,
      ...account,
    })),
    error: null,
  }
  return {
    rpc: vi.fn().mockResolvedValue(linesResult),
    from: vi.fn().mockImplementation((table: string) => {
      // Ruta 05 also collects the company's own momspliktiga intäktskonton,
      // read off chart_of_accounts rather than the fixed ACCOUNT_RUTA map.
      if (table === 'chart_of_accounts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          lte: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          not: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: vi.fn().mockResolvedValue(chartResult),
          then: (resolve: (v: unknown) => void) => resolve(chartResult),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue(fiscalPeriodResult),
        range: vi.fn().mockResolvedValue(linesResult),
        then: (resolve: (v: unknown) => void) => resolve(linesResult),
      }
    }),
  }
}

/** The { p_start, p_end } the route handed to get_vat_ruta_source_lines. */
function rpcPeriod(supabase: SupabaseShape): { start: string; end: string } {
  const args = supabase.rpc.mock.calls[0][1] as { p_start: string; p_end: string }
  return { start: args.p_start, end: args.p_end }
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

describe('GET /api/reports/vat-declaration/ruta/[ruta]/sources', () => {
  it('returns 401 when not authenticated', async () => {
    authFail(buildSupabase({ data: [], error: null }))
    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/10/sources',
      { searchParams: { periodType: 'monthly', year: '2026', period: '5' } }
    )
    const res = await GET(req, createMockRouteParams({ ruta: '10' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when period params are missing', async () => {
    authOk(buildSupabase({ data: [], error: null }))
    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/10/sources'
    )
    const res = await GET(req, createMockRouteParams({ ruta: '10' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when ruta has no underlying BAS accounts', async () => {
    authOk(buildSupabase({ data: [], error: null }))
    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/99/sources',
      { searchParams: { periodType: 'monthly', year: '2026', period: '5' } }
    )
    const res = await GET(req, createMockRouteParams({ ruta: '99' }))
    expect(res.status).toBe(404)
  })

  it('happy path: returns mapped lines for ruta10', async () => {
    const linesData = [
      {
        line_id: 'line-1',
        journal_entry_id: 'je-1',
        voucher_number: 12,
        voucher_series: 'A',
        entry_date: '2026-05-12',
        description: 'Faktura 1001',
        debit_amount: 0,
        credit_amount: 250,
      },
    ]
    authOk(buildSupabase({ data: linesData, error: null }))

    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/10/sources',
      { searchParams: { periodType: 'monthly', year: '2026', period: '5' } }
    )
    const res = await GET(req, createMockRouteParams({ ruta: '10' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        ruta: string
        lines: Array<{ voucher_number: number; credit: number }>
      }
    }

    expect(body.data.ruta).toBe('ruta10')
    expect(body.data.lines).toHaveLength(1)
    expect(body.data.lines[0].voucher_number).toBe(12)
    expect(body.data.lines[0].credit).toBe(250)
  })

  it('returns 400 when the cursor date component is not a structural ISO date', async () => {
    // Defense-in-depth (ASVS V1.2): the cursor is applied in JS, but a
    // malformed date component must still be rejected structurally.
    authOk(buildSupabase({ data: [], error: null }))
    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/10/sources',
      {
        searchParams: {
          periodType: 'monthly',
          year: '2026',
          period: '5',
          cursor: 'notadate|5',
        },
      }
    )
    const res = await GET(req, createMockRouteParams({ ruta: '10' }))
    expect(res.status).toBe(400)
  })

  it('preserves the stable chronological order returned by the paged RPC', async () => {
    const linesData = [
      {
        line_id: 'line-early',
        journal_entry_id: 'je-early',
        voucher_number: 4,
        voucher_series: 'A',
        entry_date: '2026-05-02',
        description: 'Early',
        debit_amount: 0,
        credit_amount: 100,
      },
      {
        line_id: 'line-mid',
        journal_entry_id: 'je-mid',
        voucher_number: 18,
        voucher_series: 'A',
        entry_date: '2026-05-11',
        description: 'Mid',
        debit_amount: 0,
        credit_amount: 250,
      },
      {
        line_id: 'line-late',
        journal_entry_id: 'je-late',
        voucher_number: 30,
        voucher_series: 'A',
        entry_date: '2026-05-20',
        description: 'Late',
        debit_amount: 0,
        credit_amount: 500,
      },
    ]
    authOk(buildSupabase({ data: linesData, error: null }))

    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/10/sources',
      { searchParams: { periodType: 'monthly', year: '2026', period: '5' } }
    )
    const res = await GET(req, createMockRouteParams({ ruta: '10' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: { lines: Array<{ journal_entry_id: string }> }
    }

    expect(body.data.lines.map((l) => l.journal_entry_id)).toEqual([
      'je-early',
      'je-mid',
      'je-late',
    ])
  })
})

describe('GET /api/reports/vat-declaration/ruta/[ruta]/sources: account overrides', () => {
  /** The p_accounts array the route handed to get_vat_ruta_source_lines. */
  function rpcAccounts(supabase: SupabaseShape): string[] {
    return (supabase.rpc.mock.calls[0][1] as { p_accounts: string[] }).p_accounts
  }

  function get(ruta: string) {
    const req = createMockRequest(
      `/api/reports/vat-declaration/ruta/${ruta}/sources`,
      { searchParams: { periodType: 'monthly', year: '2026', period: '5' } }
    )
    return GET(req, createMockRouteParams({ ruta }))
  }

  it('drills into the company own revenue accounts too (#1261)', async () => {
    // Without this the drill-down would list a smaller sum than the ruta 05
    // figure it drills into: the konto feeds the total but not the source list.
    const supabase = buildSupabase({ data: [], error: null }, { data: null, error: null }, [
      { account_number: '3013', default_vat_rate: 0.06 },
    ])
    authOk(supabase)

    expect((await get('05')).status).toBe(200)

    const accounts = rpcAccounts(supabase)
    expect(accounts).toContain('3013')
    expect(accounts).toContain('3001') // static mapping still there
  })

  it('drills into a null-rate account when its number and label resolve the rate (#1289)', async () => {
    const supabase = buildSupabase({ data: [], error: null }, { data: null, error: null }, [{
      account_number: '3011',
      account_name: 'Försäljning tjänster inom Sverige, 25 % moms',
      default_vat_rate: null,
    }])
    authOk(supabase)

    expect((await get('05')).status).toBe(200)
    expect(rpcAccounts(supabase)).toContain('3011')
  })

  it('leaves other rutor on the static mapping alone', async () => {
    const supabase = buildSupabase({ data: [], error: null }, { data: null, error: null }, [
      { account_number: '3013', default_vat_rate: 0.06 },
    ])
    authOk(supabase)

    expect((await get('10')).status).toBe(200)

    const accounts = rpcAccounts(supabase)
    expect(accounts).toContain('2611')
    expect(accounts).not.toContain('3013')
    // Every ruta resolves explicit account overrides before the static BAS
    // fallback, but a ruta 05-only custom account still stays out of ruta 10.
    expect(supabase.from).toHaveBeenCalledWith('chart_of_accounts')
  })

  it('drills into a custom EU purchase account in ruta 20', async () => {
    const supabase = buildSupabase({ data: [], error: null }, { data: null, error: null }, [{
      account_number: '4056',
      account_name: 'Inköp varor 25% EU',
      account_class: 4,
      default_vat_rate: 0.25,
      default_vat_treatment: 'reverse_charge_eu_goods',
    }])
    authOk(supabase)

    expect((await get('20')).status).toBe(200)
    expect(rpcAccounts(supabase)).toContain('4056')
  })
})

describe('GET /api/reports/vat-declaration/ruta/[ruta]/sources: period resolution', () => {
  // A first räkenskapsår may run up to 18 months (BFL 3 kap 3 §), and
  // helårsmoms is filed per räkenskapsår, not per calendar year
  // (SFL 26 kap 10-11 §§).
  const EXTENDED_FIRST_YEAR = { period_start: '2025-07-03', period_end: '2026-12-31' }
  const CALENDAR_YEAR = { period_start: '2026-01-01', period_end: '2026-12-31' }

  const noLines = () => ({ data: [], error: null })

  function get(searchParams: Record<string, string>, ruta = '05') {
    const req = createMockRequest(
      `/api/reports/vat-declaration/ruta/${ruta}/sources`,
      { searchParams }
    )
    return GET(req, createMockRouteParams({ ruta }))
  }

  it('yearly: drills into the räkenskapsår, agreeing with the declaration resolver', async () => {
    const supabase = buildSupabase(noLines(), { data: EXTENDED_FIRST_YEAR, error: null })
    authOk(supabase)

    const res = await get({ periodType: 'yearly', year: '2026', period: '1' })
    expect(res.status).toBe(200)

    // The old calendar-span behaviour would have started 2026-01-01 and hidden
    // every verifikat from 2025-07-03 to 2025-12-31 that the declaration counts.
    expect(rpcPeriod(supabase)).toEqual({ start: '2025-07-03', end: '2026-12-31' })

    // And it is the exact span `calculateVatDeclaration` computes the figure
    // from: both go through resolvePeriodDates with the same arguments.
    const declarationPeriod = await resolvePeriodDates(
      buildSupabase(noLines(), {
        data: EXTENDED_FIRST_YEAR,
        error: null,
      }) as unknown as Parameters<typeof resolvePeriodDates>[0],
      'company-1',
      'yearly',
      2026,
      1
    )
    expect(rpcPeriod(supabase)).toEqual(declarationPeriod)
  })

  it('yearly: an explicit fiscal_period_id selects that räkenskapsår', async () => {
    const supabase = buildSupabase(noLines(), { data: EXTENDED_FIRST_YEAR, error: null })
    authOk(supabase)

    const res = await get({
      periodType: 'yearly',
      year: '2026',
      period: '1',
      fiscal_period_id: '11111111-1111-4111-8111-111111111111',
    })
    expect(res.status).toBe(200)
    expect(rpcPeriod(supabase)).toEqual({ start: '2025-07-03', end: '2026-12-31' })
  })

  it('yearly: calendar-year company is unchanged (Jan-Dec)', async () => {
    const supabase = buildSupabase(noLines(), { data: CALENDAR_YEAR, error: null })
    authOk(supabase)

    const res = await get({ periodType: 'yearly', year: '2026', period: '1' })
    expect(res.status).toBe(200)
    expect(rpcPeriod(supabase)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('yearly: falls back to the calendar span when no fiscal period is found', async () => {
    const supabase = buildSupabase(noLines(), { data: null, error: null })
    authOk(supabase)

    const res = await get({ periodType: 'yearly', year: '2026', period: '1' })
    expect(res.status).toBe(200)
    expect(rpcPeriod(supabase)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('monthly: stays a calendar month even for a broken fiscal year', async () => {
    // kalendermånad per SFL 26 kap: fiscal_period_id must not widen the span.
    const supabase = buildSupabase(noLines(), { data: EXTENDED_FIRST_YEAR, error: null })
    authOk(supabase)

    const res = await get({
      periodType: 'monthly',
      year: '2026',
      period: '5',
      fiscal_period_id: '11111111-1111-4111-8111-111111111111',
    })
    expect(res.status).toBe(200)
    expect(rpcPeriod(supabase)).toEqual({ start: '2026-05-01', end: '2026-05-31' })
  })

  it('quarterly: stays a calendar quarter', async () => {
    const supabase = buildSupabase(noLines(), { data: EXTENDED_FIRST_YEAR, error: null })
    authOk(supabase)

    const res = await get({ periodType: 'quarterly', year: '2026', period: '2' })
    expect(res.status).toBe(200)
    expect(rpcPeriod(supabase)).toEqual({ start: '2026-04-01', end: '2026-06-30' })
  })

  it('returns 400 for an unknown periodType', async () => {
    authOk(buildSupabase(noLines()))
    const res = await get({ periodType: 'weekly', year: '2026', period: '5' })
    expect(res.status).toBe(400)
  })

  it('fiscal_period_id alone still selects the period by its own bounds', async () => {
    const supabase = buildSupabase(noLines(), { data: EXTENDED_FIRST_YEAR, error: null })
    authOk(supabase)

    const res = await get({ fiscal_period_id: '11111111-1111-4111-8111-111111111111' })
    expect(res.status).toBe(200)
    expect(rpcPeriod(supabase)).toEqual({ start: '2025-07-03', end: '2026-12-31' })
  })

  it('returns 404 when fiscal_period_id alone matches no period', async () => {
    authOk(buildSupabase(noLines(), { data: null, error: null }))
    const res = await get({ fiscal_period_id: '11111111-1111-4111-8111-111111111111' })
    expect(res.status).toBe(404)
  })
})
