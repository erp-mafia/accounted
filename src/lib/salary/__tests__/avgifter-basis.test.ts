/**
 * The avgifter the report states per category are the ones the AGI declares:
 * same category, cap split, overrides and whole-krona computation, in the
 * month the AGI files the pay (the payment date).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { declaredAvgifterForRun } from '@/lib/salary/declared-avgifter'
import { generateAvgifterBasis } from '../avgifter-basis'

const h = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('@/lib/supabase/fetch-all', async (original) => ({
  ...(await original<typeof import('@/lib/supabase/fetch-all')>()),
  fetchAllRows: vi.fn(async () => h.rows),
}))

const PARAMS = { avgifterTotal: 0.3142, avgifterReduced65plus: 0.1021, avgifterYouthRate: 0.2081, avgifterYouthSalaryCap: 25000 }
const RUN = { id: 'run-sep', period_year: 2026, period_month: 9, payment_date: '2026-09-25', status: 'booked', calculation_params: PARAMS }

const row = (fields: Record<string, unknown>) => ({
  id: 'r',
  avgifter_basis: 30000,
  avgifter_amount: 9426,
  avgifter_rate: 0.3142,
  avgifter_category: 'standard',
  avgifter_basis_override: null,
  avgifter_amount_override: null,
  removed_from_agi: false,
  employee: { f_skatt_status: 'a_skatt' },
  salary_run: RUN,
  ...fields,
})

const report = () => generateAvgifterBasis({} as SupabaseClient, 'c', 2026)

beforeEach(() => {
  h.rows = []
})

describe('generateAvgifterBasis', () => {
  it('splits a youth payslip at the cap, as the AGI does', async () => {
    const youth = row({ avgifter_rate: 0.2081, avgifter_category: 'youth', avgifter_amount: 6773.5 })
    h.rows = [youth]
    const { rows, totals } = await report()
    expect(rows.map((r) => [r.category, r.basis, r.amount, r.employeeCount])).toEqual([
      ['standard', 5000, 1571, 1],
      ['youth', 25000, 5202, 1],
    ])
    const declared = declaredAvgifterForRun([youth as never], PARAMS)
    expect(totals).toMatchObject({ totalBasis: declared.totalUnderlag, totalAmount: declared.totalAmount })
  })

  it('states an override to 0 as nothing, not the calculated figures', async () => {
    h.rows = [row({ avgifter_basis_override: 0, avgifter_amount_override: 0 })]
    const { rows, totals } = await report()
    expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBe(0)
    expect(totals).toMatchObject({ totalBasis: 0, totalAmount: 0 })
  })

  it('computes whole kronor per sats, not öre per employee', async () => {
    h.rows = [0, 1, 2, 3].map((i) => row({ id: `r${i}`, avgifter_basis: 30000.99, avgifter_amount: 9426.31 }))
    expect((await report()).totals).toMatchObject({ totalBasis: 120000, totalAmount: 37704 })
  })

  it('reads the stored category first: a legacy växa-stöd row at 10,21 % is standard', async () => {
    h.rows = [row({ avgifter_rate: 0.1021, avgifter_category: 'vaxa_stod', avgifter_amount: 3063 })]
    expect((await report()).rows.map((r) => r.category)).toEqual(['standard'])
  })

  it('leaves an F-skatt payee and a borttag out, as the AGI does', async () => {
    h.rows = [
      row({ id: 'f', employee: { f_skatt_status: 'f_skatt' } }),
      row({ id: 'gone', removed_from_agi: true }),
    ]
    expect((await report()).totals).toMatchObject({ totalBasis: 0, totalAmount: 0 })
  })

  it('files pay in the month it was paid: December paid in January belongs to the next year', async () => {
    const decemberPaidJanuary = { ...RUN, id: 'run-dec', period_month: 12, payment_date: '2027-01-25' }
    const augustPaidSeptember = { ...RUN, id: 'run-aug', period_month: 8, payment_date: '2026-09-25' }
    h.rows = [row({ id: 'a', salary_run: augustPaidSeptember }), row({ id: 'b', salary_run: decemberPaidJanuary })]
    const { rows } = await report()
    expect(rows.map((r) => [r.periodYear, r.periodMonth])).toEqual([[2026, 9]])
    expect((await generateAvgifterBasis({} as SupabaseClient, 'c', 2027)).rows.map((r) => r.periodMonth)).toEqual([1])
  })

  it('counts only booked runs', async () => {
    h.rows = [row({ salary_run: { ...RUN, status: 'approved' } })]
    expect((await report()).rows).toEqual([])
  })

  it('sums two runs of one month in one row per category', async () => {
    h.rows = [row({ id: 'a', salary_run: { ...RUN, id: 'r1' } }), row({ id: 'b', salary_run: { ...RUN, id: 'r2' } })]
    const { rows } = await report()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ category: 'standard', basis: 60000, amount: 18852, employeeCount: 2 })
  })
})

describe('generateAvgifterBasis: several runs in one month', () => {
  const EARLY = { ...RUN, id: 'run-aug-2', period_month: 8, payment_date: '2026-09-05' }
  const rows = () => [
    row({ id: 'r1', avgifter_basis: 30002, salary_run: EARLY }),
    row({ id: 'r2', avgifter_basis: 25002, salary_run: RUN }),
  ]

  const rolloutBefore = process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
  afterEach(() => {
    if (rolloutBefore === undefined) delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
    else process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = rolloutBefore
  })

  it("states the month's one declaration, summed over its runs", async () => {
    process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = 'c'
    h.rows = rows()
    const { rows: report_, totals } = await generateAvgifterBasis({} as SupabaseClient, 'c', 2026)
    // trunc(55 004 × 31,42 %) = 17 282, what the AGI for September files.
    expect(report_).toMatchObject([{ periodMonth: 9, category: 'standard', basis: 55004, amount: 17282, employeeCount: 2 }])
    expect(totals.totalAmount).toBe(17282)
  })

  it('keeps one run per computation for a company outside the list', async () => {
    delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
    h.rows = rows()
    const { totals } = await generateAvgifterBasis({} as SupabaseClient, 'c', 2026)
    expect(totals.totalAmount).toBe(9426 + 7855)
  })
})
