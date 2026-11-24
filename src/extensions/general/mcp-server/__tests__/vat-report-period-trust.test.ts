/**
 * gnubok_get_vat_report answers what an agent needs to trust the period, as
 * the other report tools do:
 *
 *   - data_status, from the shared buildRangeDataStatus over the momsperiod's
 *     own dates, so an open period reads as preliminary;
 *   - a warning when the period asked for is of another cadence than the
 *     company's moms_period: no declaration is filed for it;
 *   - a refusal naming the räkenskapsår that exist when no räkenskapsår ends
 *     in a yearly `year`, instead of figures over January to December.
 *
 * buildRangeDataStatus itself is covered in lib/reports/__tests__/data-status.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rangeDataStatus } = vi.hoisted(() => ({ rangeDataStatus: vi.fn() }))
vi.mock('@/lib/reports/data-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/data-status')>()),
  buildRangeDataStatus: rangeDataStatus,
}))

import { tools } from '../server'
import { vatTotalsRpcResult } from './vat-totals-rpc-double'

const getVatReport = () => tools.find((tool) => tool.name === 'gnubok_get_vat_report')!

const LINES = [
  { journal_entry_id: 'e-1', account_number: '3001', debit_amount: 0, credit_amount: 1000 },
  { journal_entry_id: 'e-1', account_number: '2611', debit_amount: 0, credit_amount: 250 },
]

function mockSupabase(opts: {
  fiscalPeriods?: Array<{ period_start: string; period_end: string }>
  momsPeriod?: string | null
}) {
  const makeChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null }
    chain.range = () => settled
    chain.single = async () => ({ data: rows[0] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of ['order', 'lte', 'gte', 'neq', 'in', 'not', 'eq', 'select', 'limit', 'contains', 'filter']) {
      chain[m] = () => chain
    }
    return chain
  }
  return {
    from: (table: string) => {
      if (table === 'fiscal_periods') return makeChain(opts.fiscalPeriods ?? [])
      if (table === 'company_settings') return makeChain([{ moms_period: opts.momsPeriod ?? null }])
      return makeChain([])
    },
    rpc: (fn: string, params?: { p_accounts?: string[] }) =>
      Promise.resolve(
        fn === 'get_vat_declaration_totals'
          ? vatTotalsRpcResult({ lines: LINES }, params)
          : { data: null, error: null },
      ),
  } as never
}

const PRELIMINARY = { preliminary: true, caveats: ['Period 2026 is open: these figures can still change.'] }

beforeEach(() => {
  vi.clearAllMocks()
  rangeDataStatus.mockResolvedValue(PRELIMINARY)
})

describe('gnubok_get_vat_report: data_status', () => {
  it('carries the data status of the momsperiod\'s own dates', async () => {
    const supabase = mockSupabase({ momsPeriod: 'quarterly' })

    const result = (await getVatReport().execute(
      { period_type: 'quarterly', year: 2026, period: 3 },
      'company-1',
      'user-1',
      supabase,
    )) as Record<string, unknown>

    expect(rangeDataStatus).toHaveBeenCalledWith(supabase, 'company-1', { from: '2026-07-01', to: '2026-09-30' })
    expect(result.data_status).toEqual(PRELIMINARY)
    expect(result.rutor).toMatchObject({ ruta05: 1000, ruta10: 250 })
    expect(result.warnings).toEqual([])
  })

  it('carries null when no one fiscal period holds the momsperiod', async () => {
    rangeDataStatus.mockResolvedValue(null)

    const result = (await getVatReport().execute(
      { period_type: 'quarterly', year: 2026, period: 3 },
      'company-1',
      'user-1',
      mockSupabase({ momsPeriod: 'quarterly' }),
    )) as Record<string, unknown>

    expect(result).toHaveProperty('data_status', null)
  })
})

describe('gnubok_get_vat_report: a period of another cadence than moms_period', () => {
  it('warns that a quarter of a yearly filer is no declaration period', async () => {
    const result = (await getVatReport().execute(
      { period_type: 'quarterly', year: 2026, period: 3 },
      'company-1',
      'user-1',
      mockSupabase({ momsPeriod: 'yearly' }),
    )) as { warnings: string[] }

    expect(result.warnings).toEqual([
      expect.stringContaining('Q3 2026 (2026-07-01..2026-09-30) är ingen deklarationsperiod för företaget'),
    ])
    expect(result.warnings[0]).toContain('moms_period yearly')
  })

  it('does not warn when moms_period is not set', async () => {
    const result = (await getVatReport().execute(
      { period_type: 'monthly', year: 2026, period: 3 },
      'company-1',
      'user-1',
      mockSupabase({ momsPeriod: null }),
    )) as { warnings: string[] }

    expect(result.warnings).toEqual([])
  })
})

describe('gnubok_get_vat_report: a yearly period no räkenskapsår ends in', () => {
  it('refuses, naming the räkenskapsår that exist, and computes nothing', async () => {
    await expect(
      getVatReport().execute(
        { period_type: 'yearly', year: 2025, period: 1 },
        'company-1',
        'user-1',
        mockSupabase({
          momsPeriod: 'yearly',
          fiscalPeriods: [{ period_start: '2025-07-17', period_end: '2026-12-31' }],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VAT_REPORT_FISCAL_YEAR_NOT_FOUND',
      message: expect.stringContaining('2025-07-17..2026-12-31 (year 2026)'),
    })
    expect(rangeDataStatus).not.toHaveBeenCalled()
  })

  it('reports the year it ends in over the whole räkenskapsår', async () => {
    const result = (await getVatReport().execute(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      'user-1',
      mockSupabase({
        momsPeriod: 'yearly',
        fiscalPeriods: [{ period_start: '2025-07-17', period_end: '2026-12-31' }],
      }),
    )) as { period: unknown; warnings: string[] }

    expect(result.period).toMatchObject({ start: '2025-07-17', end: '2026-12-31' })
    expect(result.warnings).toEqual([])
    expect(rangeDataStatus).toHaveBeenCalledWith(expect.anything(), 'company-1', { from: '2025-07-17', to: '2026-12-31' })
  })
})
