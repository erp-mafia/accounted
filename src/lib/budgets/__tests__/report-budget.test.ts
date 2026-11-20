/**
 * The budget a report compares with (accounted#134, part 2): whole months
 * only, the budget of the report's year only, summed in the database
 * (get_budget_line_sums) and turned to the report's sign.
 */
import { describe, it, expect } from 'vitest'
import {
  budgetDisclosure,
  loadReportBudget,
  parseBudgetParam,
  ReportBudgetError,
  wholeMonthWindow,
} from '../report-budget'
import { createTableMockSupabase } from '@/tests/helpers'

const YEAR = { start: '2026-01-01', end: '2026-12-31' }

describe('wholeMonthWindow', () => {
  it('takes windows that start and end with whole months', () => {
    expect(wholeMonthWindow({ from: '2026-01-01', to: '2026-12-31' }, YEAR)).toEqual({ fromMonth: '2026-01', toMonth: '2026-12' })
    expect(wholeMonthWindow({ from: '2026-04-01', to: '2026-06-30' }, YEAR)).toEqual({ fromMonth: '2026-04', toMonth: '2026-06' })
    expect(wholeMonthWindow({ from: '2026-02-01', to: '2026-02-28' }, YEAR)).toEqual({ fromMonth: '2026-02', toMonth: '2026-02' })
  })

  it('refuses a window that cuts a month (year to date until today)', () => {
    expect(wholeMonthWindow({ from: '2026-01-01', to: '2026-10-29' }, YEAR)).toBeNull()
    expect(wholeMonthWindow({ from: '2026-01-15', to: '2026-03-31' }, YEAR)).toBeNull()
  })

  it('counts a first year\'s mid-month start as a whole month, as the budget does', () => {
    expect(wholeMonthWindow({ from: '2026-03-15', to: '2026-04-30' }, { start: '2026-03-15', end: '2027-04-30' })).toEqual({
      fromMonth: '2026-03',
      toMonth: '2026-04',
    })
  })
})

describe('parseBudgetParam and budgetDisclosure', () => {
  it('reads an id, nothing, or refuses anything else', () => {
    expect(parseBudgetParam(new URLSearchParams(''))).toEqual({ ok: true })
    expect(parseBudgetParam(new URLSearchParams('budget_id=dddddddd-dddd-4ddd-8ddd-dddddddddddd'))).toEqual({
      ok: true,
      budgetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })
    expect(parseBudgetParam(new URLSearchParams('budget_id=default')).ok).toBe(false)
  })

  it('names the budget and its months, or why there are no figures', () => {
    const base = { budget_id: 'b', name: 'Budget 2026', is_default: true }
    expect(budgetDisclosure(undefined)).toBeNull()
    expect(budgetDisclosure({ ...base, applied: true, from_month: '2026-01', to_month: '2026-06' })).toBe('Budget Budget 2026: 2026-01 till 2026-06')
    expect(budgetDisclosure({ ...base, applied: false, from_month: null, to_month: null })).toContain('hela månader')
  })
})

describe('loadReportBudget', () => {
  const params = {
    budgetId: 'b1',
    fiscalPeriodId: 'p1',
    period: YEAR,
    window: { from: '2026-01-01', to: '2026-03-31' },
  }

  it('sums the window in the database and answers in the report\'s sign', async () => {
    const mock = createTableMockSupabase({
      budgets: { data: { id: 'b1', fiscal_period_id: 'p1', name: 'Budget 2026', is_default: true }, error: null },
      'rpc:get_budget_line_sums': {
        data: [
          { account_number: '3010', month: null, dim_code: 'H1', amount: -900 },
          { account_number: '3010', month: null, dim_code: null, amount: -100 },
          { account_number: '5010', month: null, dim_code: 'H1', amount: 300 },
        ],
        error: null,
      },
      chart_of_accounts: { data: [{ account_number: '3010', account_name: 'Försäljning' }], error: null },
    })
    const budget = await loadReportBudget(mock.supabase as never, 'c1', { ...params, dimensions: { '1': 'K1' }, groupDim: '6' })

    expect(budget.info).toEqual({ budget_id: 'b1', name: 'Budget 2026', is_default: true, applied: true, from_month: '2026-01', to_month: '2026-03' })
    expect([...budget.byAccount]).toEqual([['3010', 1000], ['5010', -300]])
    expect([...budget.byAccountCode.get('3010')!]).toEqual([['H1', 900], ['', 100]])
    expect(budget.accountNames.get('3010')).toBe('Försäljning')
    expect(mock.findCall('rpc:get_budget_line_sums', 'rpc')?.[0]).toEqual({
      p_company_id: 'c1',
      p_budget_id: 'b1',
      p_from: '2026-01-01',
      p_to: '2026-03-01',
      p_dimensions: { '1': 'K1' },
      p_exact: false,
      p_by_month: false,
      p_group_dim: '6',
    })
    // Scoped to the company even though the budget id is known.
    expect(mock.calls).toContainEqual({ table: 'budgets', method: 'eq', args: ['company_id', 'c1'] })
  })

  it('refuses another company\'s budget and another year\'s, and reads nothing for a cut month', async () => {
    const none = createTableMockSupabase({ budgets: { data: null, error: null } })
    await expect(loadReportBudget(none.supabase as never, 'c1', params)).rejects.toMatchObject({ code: 'BUDGET_NOT_FOUND' })

    const other = createTableMockSupabase({ budgets: { data: { id: 'b1', fiscal_period_id: 'p0', name: 'B', is_default: false }, error: null } })
    await expect(loadReportBudget(other.supabase as never, 'c1', params)).rejects.toBeInstanceOf(ReportBudgetError)

    const cut = createTableMockSupabase({ budgets: { data: { id: 'b1', fiscal_period_id: 'p1', name: 'B', is_default: false }, error: null } })
    const budget = await loadReportBudget(cut.supabase as never, 'c1', { ...params, window: { from: '2026-01-01', to: '2026-03-15' } })
    expect(budget.info.applied).toBe(false)
    expect(cut.calls.some((c) => c.table === 'rpc:get_budget_line_sums')).toBe(false)
  })
})
