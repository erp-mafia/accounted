import { describe, it, expect, vi } from 'vitest'
import {
  fetchKpiAggregates,
  buildOpeningBalances,
  buildTrialBalanceRows,
  type KpiAggregates,
} from '../kpi-aggregates'

function emptyAgg(overrides: Partial<KpiAggregates> = {}): KpiAggregates {
  return { tb: [], tb_ex_year_end: [], ob: [], monthly: [], ...overrides }
}

describe('fetchKpiAggregates', () => {
  it('calls the RPC with the expected args and coerces numbers', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        tb: [{ account_number: '1930', debit: '125.5', credit: 0 }],
        tb_ex_year_end: [{ account_number: '3001', debit: null, credit: 100 }],
        ob: [],
        monthly: [{ year: 2026, month: '2', income: '10.25', expenses: undefined }],
      },
      error: null,
    })
    const supabase = { rpc } as never

    const agg = await fetchKpiAggregates(supabase, 'company-1', 'period-1', 'ob-1')

    expect(rpc).toHaveBeenCalledWith('get_kpi_report_aggregates', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_ob_entry_id: 'ob-1',
    })
    expect(agg.tb).toEqual([{ account_number: '1930', debit: 125.5, credit: 0 }])
    expect(agg.tb_ex_year_end).toEqual([{ account_number: '3001', debit: 0, credit: 100 }])
    expect(agg.ob).toEqual([])
    expect(agg.monthly).toEqual([{ year: 2026, month: 2, income: 10.25, expenses: 0 }])
  })

  it('defaults missing sections to empty arrays', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null })
    const supabase = { rpc } as never

    const agg = await fetchKpiAggregates(supabase, 'company-1', 'period-1', null)
    expect(agg).toEqual(emptyAgg())
    expect(rpc).toHaveBeenCalledWith('get_kpi_report_aggregates', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_ob_entry_id: null,
    })
  })

  it('throws a prefixed error when the RPC fails', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })
    const supabase = { rpc } as never

    await expect(
      fetchKpiAggregates(supabase, 'company-1', 'period-1', null)
    ).rejects.toThrow('get_kpi_report_aggregates failed: boom')
  })
})

describe('buildOpeningBalances', () => {
  it('OB-entry path (priorRows null): additive accumulation with Number coercion', () => {
    const agg = emptyAgg({
      ob: [
        { account_number: '1930', debit: 5000, credit: 0 },
        // A duplicate account accumulates additively, mirroring the
        // per-line loop in opening-balances.ts lines 57-62.
        { account_number: '1930', debit: 250.5, credit: 0 },
        { account_number: '2010', debit: 0, credit: 5250.5 },
      ],
    })

    const balances = buildOpeningBalances(agg, null)
    expect(balances.get('1930')).toEqual({ debit: 5250.5, credit: 0 })
    expect(balances.get('2010')).toEqual({ debit: 0, credit: 5250.5 })
    expect(balances.size).toBe(2)
  })

  it('fallback path: uses priorRows with Number()||0 coercion, ignoring the ob section', () => {
    const agg = emptyAgg({
      ob: [{ account_number: '9999', debit: 1, credit: 1 }],
    })
    // compute_prior_opening_balances returns numerics that may arrive as
    // strings through PostgREST: mirrors opening-balances.ts lines 77-86.
    const balances = buildOpeningBalances(agg, [
      { account_number: '1930', debit: '1500.25', credit: '0' },
      { account_number: '2440', debit: 'not-a-number', credit: 300 },
    ])

    expect(balances.get('1930')).toEqual({ debit: 1500.25, credit: 0 })
    expect(balances.get('2440')).toEqual({ debit: 0, credit: 300 })
    expect(balances.has('9999')).toBe(false)
  })

  it('empty inputs produce an empty map in both shapes', () => {
    expect(buildOpeningBalances(emptyAgg(), null).size).toBe(0)
    expect(buildOpeningBalances(emptyAgg(), []).size).toBe(0)
  })
})

describe('buildTrialBalanceRows', () => {
  const accountMap = new Map<string, { name: string; class: number }>([
    ['1930', { name: 'Företagskonto', class: 1 }],
    ['3001', { name: 'Försäljning 25%', class: 3 }],
  ])

  it('merges opening and period accounts and computes IB + period = UB', () => {
    const opening = new Map([
      ['1930', { debit: 5000, credit: 0 }],
      // Account only in opening: must still get a row.
      ['2081', { debit: 0, credit: 25000 }],
    ])
    const periodSums = [
      { account_number: '1930', debit: 12500, credit: 3000 },
      // Account only in period: must still get a row.
      { account_number: '3001', debit: 0, credit: 10000 },
    ]

    const rows = buildTrialBalanceRows(opening, periodSums, accountMap)

    expect(rows.map((r) => r.account_number)).toEqual(['1930', '2081', '3001'])
    expect(rows[0]).toEqual({
      account_number: '1930',
      account_name: 'Företagskonto',
      account_class: 1,
      opening_debit: 5000,
      opening_credit: 0,
      period_debit: 12500,
      period_credit: 3000,
      closing_debit: 17500,
      closing_credit: 3000,
    })
    expect(rows[1]).toMatchObject({
      account_number: '2081',
      opening_credit: 25000,
      period_debit: 0,
      period_credit: 0,
      closing_credit: 25000,
    })
    expect(rows[2]).toMatchObject({
      account_number: '3001',
      account_name: 'Försäljning 25%',
      account_class: 3,
      opening_debit: 0,
      period_credit: 10000,
      closing_credit: 10000,
    })
  })

  it('falls back to "Konto <n>" naming and first-digit class for unknown accounts', () => {
    const rows = buildTrialBalanceRows(
      new Map(),
      [
        { account_number: '2611', debit: 0, credit: 2500 },
        { account_number: 'X99', debit: 1, credit: 0 },
      ],
      accountMap
    )

    const unknown = rows.find((r) => r.account_number === '2611')!
    expect(unknown.account_name).toBe('Konto 2611')
    expect(unknown.account_class).toBe(2)

    // parseInt(n[0]) || 0 fallback: non-numeric first char lands class 0,
    // same as trial-balance.ts line 306.
    const weird = rows.find((r) => r.account_number === 'X99')!
    expect(weird.account_name).toBe('Konto X99')
    expect(weird.account_class).toBe(0)
  })

  it('rounds all six amount fields with Math.round(x * 100) / 100', () => {
    const opening = new Map([['1930', { debit: 0.1, credit: 0 }]])
    const rows = buildTrialBalanceRows(
      opening,
      [{ account_number: '1930', debit: 0.2, credit: 0.005 }],
      accountMap
    )

    // 0.1 + 0.2 = 0.30000000000000004 raw: closing must land on 0.3 exactly.
    expect(rows[0].opening_debit).toBe(0.1)
    expect(rows[0].period_debit).toBe(0.2)
    expect(rows[0].closing_debit).toBe(0.3)
    expect(rows[0].period_credit).toBe(0.01)
    expect(rows[0].closing_credit).toBe(0.01)
  })

  it('sorts rows by account_number with localeCompare', () => {
    const rows = buildTrialBalanceRows(
      new Map(),
      [
        { account_number: '8999', debit: 1, credit: 0 },
        { account_number: '1510', debit: 1, credit: 0 },
        { account_number: '2440', debit: 1, credit: 0 },
      ],
      accountMap
    )
    expect(rows.map((r) => r.account_number)).toEqual(['1510', '2440', '8999'])
  })

  it('returns no rows when both inputs are empty', () => {
    expect(buildTrialBalanceRows(new Map(), [], accountMap)).toEqual([])
  })
})
