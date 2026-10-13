/**
 * gnubok_vat_close_check: unattested supplier invoices under kontantmetoden
 * (agent feedback seq 878478).
 *
 * Under bokslutsmetoden (accounting_method 'cash') ingående moms is recognised
 * when a supplier invoice is paid, except at the räkenskapsår's end, when
 * unpaid invoices are booked. An unattested invoice therefore does not move a
 * cash-method company's moms for a period that does not hold the fiscal year
 * end, and the check used to block every such period on it anyway.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

import { computeVatCloseCheck, vatPeriodContainsFiscalYearEnd } from '@/lib/reports/vat-close-check'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/**
 * Table-routed double: two registered (unattested) supplier invoices, the
 * given settings row, the given fiscal_periods rows (none by default),
 * everything else empty. Filter calls are recorded per table.
 */
type Call = { table: string; method: string; args: unknown[] }

function mockSupabase(settings: Record<string, unknown>, fiscalPeriods: unknown[] = []) {
  const calls: Call[] = []
  const makeChain = (rows: unknown[], table = ''): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: rows[0] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of ['order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select', 'limit', 'contains', 'filter', 'not', 'or']) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      }
    }
    return chain
  }
  const rpc = vi.fn((fn: string) => {
    if (fn === 'verifikat_without_documents') {
      return Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
    }
    return makeChain([])
  })
  const client = {
    from: (table: string) => {
      if (table === 'company_settings') return makeChain([settings], table)
      if (table === 'supplier_invoices') return makeChain([{ id: 'si-1' }, { id: 'si-2' }], table)
      if (table === 'fiscal_periods') return makeChain(fiscalPeriods, table)
      return makeChain([], table)
    },
    rpc,
    calls,
  }
  return client as unknown as SupabaseClient & { calls: Call[] }
}

const supplierInvoiceDateFilters = (calls: Call[]) =>
  calls
    .filter((c) => c.table === 'supplier_invoices' && (c.method === 'gte' || c.method === 'lte'))
    .map((c) => [c.method, ...c.args])

const CASH_CALENDAR_YEAR = { moms_period: 'quarterly', vat_taxable_base_over_40m: false, accounting_method: 'cash', fiscal_year_start_month: 1 }
const ACCRUAL_CALENDAR_YEAR = { ...CASH_CALENDAR_YEAR, accounting_method: 'accrual' }

const unapproved = (result: Awaited<ReturnType<typeof computeVatCloseCheck>>) =>
  result.blockers.find((b) => b.kind === 'unapproved_supplier_invoices')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_vat_close_check: unattested supplier invoices under kontantmetoden', () => {
  it('does not block a cash-method Q3 when the fiscal year is the calendar year', async () => {
    const result = await computeVatCloseCheck(
      { period_type: 'quarterly', year: 2026, period: 3 },
      COMPANY_ID,
      mockSupabase(CASH_CALENDAR_YEAR),
    )

    const finding = unapproved(result)!
    expect(finding).toMatchObject({ severity: 'low', count: 2 })
    expect(finding.message).toMatch(/kontantmetoden/)
    expect(finding.hint).toMatch(/Blockerar inte/)
    expect(result.blockers.filter((b) => b.severity === 'high')).toEqual([])
    expect(result.ready_to_close).toBe(true)
  })

  it('still blocks the cash-method Q4: the period holds the fiscal year end', async () => {
    const supabase = mockSupabase(CASH_CALENDAR_YEAR)
    const result = await computeVatCloseCheck({ period_type: 'quarterly', year: 2026, period: 4 }, COMPANY_ID, supabase)

    expect(unapproved(result)).toMatchObject({ severity: 'high', count: 2 })
    expect(unapproved(result)!.message).toMatch(/till och med 2026-12-31/)
    expect(result.ready_to_close).toBe(false)
  })

  // Every invoice unpaid at balansdagen is booked at the räkenskapsår's end,
  // so at the year-end period the count is not limited to invoices dated in
  // the momsperiod.
  it('counts every unattested invoice dated up to the period end at the cash-method year end', async () => {
    const yearEnd = mockSupabase(CASH_CALENDAR_YEAR)
    await computeVatCloseCheck({ period_type: 'quarterly', year: 2026, period: 4 }, COMPANY_ID, yearEnd)
    expect(supplierInvoiceDateFilters(yearEnd.calls)).toEqual([['lte', 'invoice_date', '2026-12-31']])

    const accrual = mockSupabase(ACCRUAL_CALENDAR_YEAR)
    await computeVatCloseCheck({ period_type: 'quarterly', year: 2026, period: 4 }, COMPANY_ID, accrual)
    expect(supplierInvoiceDateFilters(accrual.calls)).toEqual(
      expect.arrayContaining([['gte', 'invoice_date', '2026-10-01'], ['lte', 'invoice_date', '2026-12-31']]),
    )

    const cashQ3 = mockSupabase(CASH_CALENDAR_YEAR)
    await computeVatCloseCheck({ period_type: 'quarterly', year: 2026, period: 3 }, COMPANY_ID, cashQ3)
    expect(supplierInvoiceDateFilters(cashQ3.calls)).toEqual(
      expect.arrayContaining([['gte', 'invoice_date', '2026-07-01'], ['lte', 'invoice_date', '2026-09-30']]),
    )
  })

  // The fiscal years on record decide, not the setting: a first räkenskapsår
  // or a changed year end makes fiscal_year_start_month the wrong guide.
  it('decides from the fiscal_periods rows, not the setting, when rows exist', async () => {
    // Setting says calendar year, but the recorded fiscal year ends 31 August.
    const brokenYearOnRecord = await computeVatCloseCheck(
      { period_type: 'quarterly', year: 2026, period: 3 },
      COMPANY_ID,
      mockSupabase(CASH_CALENDAR_YEAR, [{ period_end: '2026-08-31' }, { period_end: '2027-08-31' }]),
    )
    expect(unapproved(brokenYearOnRecord)).toMatchObject({ severity: 'high' })

    // Setting says September start (year end in Q3), but the recorded fiscal
    // year is the calendar year: Q3 holds no year end.
    const calendarYearOnRecord = await computeVatCloseCheck(
      { period_type: 'quarterly', year: 2026, period: 3 },
      COMPANY_ID,
      mockSupabase({ ...CASH_CALENDAR_YEAR, fiscal_year_start_month: 9 }, [{ period_end: '2026-12-31' }]),
    )
    expect(unapproved(calendarYearOnRecord)).toMatchObject({ severity: 'low' })
  })

  it('still blocks an accrual company in Q3', async () => {
    const result = await computeVatCloseCheck(
      { period_type: 'quarterly', year: 2026, period: 3 },
      COMPANY_ID,
      mockSupabase(ACCRUAL_CALENDAR_YEAR),
    )

    expect(unapproved(result)).toMatchObject({ severity: 'high', count: 2 })
    expect(result.ready_to_close).toBe(false)
  })

  it('still blocks a cash-method company whose fiscal year is unknown', async () => {
    const result = await computeVatCloseCheck(
      { period_type: 'quarterly', year: 2026, period: 3 },
      COMPANY_ID,
      mockSupabase({ ...CASH_CALENDAR_YEAR, fiscal_year_start_month: null }),
    )

    expect(unapproved(result)).toMatchObject({ severity: 'high' })
  })

  it('falls back to the setting for a broken fiscal year end when no fiscal period is on record', async () => {
    // Räkenskapsår September-August: it ends 31 August, inside Q3.
    const result = await computeVatCloseCheck(
      { period_type: 'quarterly', year: 2026, period: 3 },
      COMPANY_ID,
      mockSupabase({ ...CASH_CALENDAR_YEAR, fiscal_year_start_month: 9 }),
    )

    expect(unapproved(result)).toMatchObject({ severity: 'high' })
  })
})

describe('vatPeriodContainsFiscalYearEnd', () => {
  it('finds the fiscal year end month inside the period', () => {
    expect(vatPeriodContainsFiscalYearEnd('2026-10-01', '2026-12-31', 1)).toBe(true)
    expect(vatPeriodContainsFiscalYearEnd('2026-07-01', '2026-09-30', 1)).toBe(false)
    expect(vatPeriodContainsFiscalYearEnd('2026-07-01', '2026-09-30', 9)).toBe(true)
    expect(vatPeriodContainsFiscalYearEnd('2026-08-01', '2026-08-31', 9)).toBe(true)
    expect(vatPeriodContainsFiscalYearEnd('2026-09-01', '2026-09-30', 9)).toBe(false)
    // A yearly period over a broken fiscal year always holds its end.
    expect(vatPeriodContainsFiscalYearEnd('2025-07-01', '2026-06-30', 7)).toBe(true)
  })
})
