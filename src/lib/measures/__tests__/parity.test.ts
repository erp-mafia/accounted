/**
 * Parity: every measure equals the report it declares (`equals`), on one
 * in-memory company that both the measure and the report read
 * (./fake-ledger.ts). The report side calls the generator the dashboard and
 * the v1/MCP report doors call, never a copy. A measure without a case here
 * fails the coverage test at the bottom.
 */
import { describe, expect, it } from 'vitest'
import { createLogger } from '@/lib/logger'
import { getMeasure, REGISTERED_MEASURE_IDS } from '../registry'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { calculateCashPosition } from '@/lib/reports/kpi'
import { generateKpiReport } from '@/lib/reports/kpi-report'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { BalanceSheetReport } from '@/types'
import { createFakeLedger } from './fake-ledger'
import { CO, FP, fixtureData } from './fixtures'
import type { MeasureId, MeasureParams } from '../types'

const covered = new Set<MeasureId>()

async function measure(ledger: ReturnType<typeof createFakeLedger>, id: MeasureId, params: MeasureParams) {
  covered.add(id)
  const outcome = await getMeasure({ supabase: ledger.supabase, companyId: CO }, id, params)
  if (!outcome.ok) throw new Error(`${id} refused: ${outcome.code} ${outcome.messageSv}`)
  return outcome.data
}

function balanceRow(report: BalanceSheetReport, account: string): number {
  const rows = [...report.asset_sections, ...report.equity_liability_sections].flatMap((s) => s.rows)
  return rows.find((r) => r.account_number === account)?.amount ?? 0
}

function kpi(ledger: ReturnType<typeof createFakeLedger>) {
  return generateKpiReport(
    { supabase: ledger.supabase, companyId: CO, userId: 'user-1', log: createLogger('measures-parity') },
    { period_id: FP },
  )
}

describe('balance measures equal the balance sheet', () => {
  const ledger = createFakeLedger(fixtureData())

  for (const asOf of ['2026-03-31', '2026-06-30', '2026-12-31']) {
    it(`accounts_receivable = the 1510 row at ${asOf}`, async () => {
      const value = await measure(ledger, 'accounts_receivable', { as_of_date: asOf })
      const bs = await generateBalanceSheet(ledger.supabase, CO, FP, { toDate: asOf })
      expect(value.value).toBe(balanceRow(bs, '1510'))
    })

    it(`accounts_payable = the 2440 row at ${asOf}`, async () => {
      const value = await measure(ledger, 'accounts_payable', { as_of_date: asOf })
      const bs = await generateBalanceSheet(ledger.supabase, CO, FP, { toDate: asOf })
      expect(value.value).toBe(balanceRow(bs, '2440'))
    })

    it(`bank_balance = the rows of the registered bank accounts at ${asOf}`, async () => {
      const value = await measure(ledger, 'bank_balance', { as_of_date: asOf })
      const bs = await generateBalanceSheet(ledger.supabase, CO, FP, { toDate: asOf })
      expect(value.value).toBe(balanceRow(bs, '1930') + balanceRow(bs, '1940'))
    })
  }

  it('answers the hand-checked figures', async () => {
    // 1510: IB 12 000 + faktura 12 500 - inbetalning 12 000.
    expect((await measure(ledger, 'accounts_receivable', { as_of_date: '2026-06-30' })).value).toBe(12500)
    // 2440: IB 8 000 + hyra 10 000 - betalning 8 000.
    expect((await measure(ledger, 'accounts_payable', { as_of_date: '2026-06-30' })).value).toBe(10000)
    // 1930 55 350 + 1940 6 250; the till (1910) and the Stripe row (1686) are not bank accounts.
    expect((await measure(ledger, 'bank_balance', { as_of_date: '2026-06-30' })).value).toBe(61600)
  })
})

describe('liquid_funds equals the KPI cash position', () => {
  it('equals the KPI report (dashboard and v1) for the whole fiscal year', async () => {
    const ledger = createFakeLedger(fixtureData())
    const value = await measure(ledger, 'liquid_funds', { as_of_date: '2026-12-31' })
    const report = await kpi(ledger)
    expect(report.ok).toBe(true)
    expect(value.value).toBe(report.ok && !report.dryRun ? report.data.cashPosition : NaN)
    // 1930 55 350 + 1940 6 250 + 1910 1 000.
    expect(value.value).toBe(62600)
  })

  it('equals the MCP KPI path (trial balance to the date) and the Kassa och bank group', async () => {
    const ledger = createFakeLedger(fixtureData())
    const value = await measure(ledger, 'liquid_funds', { as_of_date: '2026-03-31' })
    const tb = await generateTrialBalance(ledger.supabase, CO, FP, { closingEntry: 'include', toDate: '2026-03-31' })
    expect(value.value).toBe(calculateCashPosition(tb.rows))
    const bs = await generateBalanceSheet(ledger.supabase, CO, FP, { toDate: '2026-03-31' })
    expect(value.value).toBe(bs.asset_sections.find((s) => s.title === 'Kassa och bank')?.subtotal)
  })

  it('follows the company KPI account override, like the KPI page, and says so', async () => {
    const ledger = createFakeLedger(fixtureData({ kpiOverrides: { cashPosition: ['1930'] } }))
    const value = await measure(ledger, 'liquid_funds', { as_of_date: '2026-12-31' })
    const report = await kpi(ledger)
    expect(value.value).toBe(report.ok && !report.dryRun ? report.data.cashPosition : NaN)
    expect(value.value).toBe(55350)
    expect(value.caveats.map((c) => c.code)).toEqual(['KPI_CASH_ACCOUNTS_CHOSEN'])
  })
})

describe('income statement measures equal the resultaträkning', () => {
  const ledger = createFakeLedger(fixtureData())
  const ranges: Array<{ label: string; params: MeasureParams; range: { fromDate?: string; toDate?: string } }> = [
    { label: 'the whole fiscal year', params: { period_id: FP }, range: {} },
    { label: 'Q2', params: { period_id: FP, from_date: '2026-04-01', to_date: '2026-06-30' }, range: { fromDate: '2026-04-01', toDate: '2026-06-30' } },
    { label: 'to a date, period found by the date', params: { to_date: '2026-05-31' }, range: { toDate: '2026-05-31' } },
  ]

  for (const { label, params, range } of ranges) {
    it(`net_revenue = nettoomsattning over ${label}`, async () => {
      const value = await measure(ledger, 'net_revenue', params)
      const report = await generateIncomeStatement(ledger.supabase, CO, FP, range)
      expect(value.value).toBe(report.nettoomsattning)
    })

    it(`operating_expenses = total_expenses over ${label}`, async () => {
      const value = await measure(ledger, 'operating_expenses', params)
      const report = await generateIncomeStatement(ledger.supabase, CO, FP, range)
      expect(value.value).toBe(report.total_expenses)
    })
  }

  for (const asOf of ['2026-03-31', '2026-06-30', '2026-12-31']) {
    it(`result_to_date = net_result from the year start to ${asOf}`, async () => {
      const value = await measure(ledger, 'result_to_date', { as_of_date: asOf })
      const report = await generateIncomeStatement(ledger.supabase, CO, FP, { toDate: asOf })
      expect(value.value).toBe(report.net_result)
    })
  }

  it('result_to_date at the year end equals the KPI net result', async () => {
    const value = await measure(ledger, 'result_to_date', { as_of_date: '2026-12-31' })
    const report = await kpi(ledger)
    expect(value.value).toBe(report.ok && !report.dryRun ? report.data.netResult : NaN)
  })

  it('answers the hand-checked figures', async () => {
    // 3001 10 000 + 5 000; 3911 hyresintäkt is övrig rörelseintäkt, not nettoomsättning.
    expect((await measure(ledger, 'net_revenue', { period_id: FP })).value).toBe(15000)
    // 5010 8 000 + 6110 400; the year-end avskrivning (7832) is a bokslut entry and the draft is not posted.
    expect((await measure(ledger, 'operating_expenses', { period_id: FP })).value).toBe(8400)
    // 15 000 + 2 000 - 8 400 - 150 ränta.
    expect((await measure(ledger, 'result_to_date', { as_of_date: '2026-06-30' })).value).toBe(8450)
  })
})

describe('vat_payable equals ruta 49 of the momsdeklaration', () => {
  const ledger = createFakeLedger(fixtureData())

  it.each([
    ['quarterly', 2026, 1, 500],
    ['quarterly', 2026, 2, 1150],
    ['monthly', 2026, 2, 500],
    ['yearly', 2026, 1, 1650],
  ] as const)('%s %i period %i', async (periodType, year, period, expected) => {
    const value = await measure(ledger, 'vat_payable', { period_type: periodType, year, period })
    const report = await calculateVatDeclaration(ledger.supabase, CO, periodType, year, period)
    expect(value.value).toBe(report.rutor.ruta49)
    // Q1: 2611 2 500 - 2641 2 000. Q2: 1 250 - 100; the Q1 momsredovisning booked in April is left out.
    expect(value.value).toBe(expected)
    expect(value.period).toMatchObject({ start: report.period.start, end: report.period.end })
  })
})

describe('invoice measures equal the reskontra', () => {
  const ledger = createFakeLedger(fixtureData())

  it('unpaid_customer_invoices = kundreskontra total and count, live', async () => {
    const value = await measure(ledger, 'unpaid_customer_invoices', {})
    const report = await generateARLedger(ledger.supabase, CO)
    expect(value.value).toBe(report.total_outstanding)
    expect(value.count).toBe(report.unpaid_count)
    // 12 500 open + 5 000 - 2 000 paid.
    expect(value).toMatchObject({ value: 15500, count: 2, as_of: todayIsoStockholm() })
  })

  it('unpaid_customer_invoices = the kundreskontra rebuilt at a past date', async () => {
    const value = await measure(ledger, 'unpaid_customer_invoices', { as_of_date: '2026-03-01' })
    const report = await generateARLedger(ledger.supabase, CO, '2026-03-01')
    expect(value.value).toBe(report.total_outstanding)
    expect(value.count).toBe(report.unpaid_count)
    expect(value.value).toBe(12500)
  })

  it('unpaid_supplier_invoices = leverantörsreskontra total and count', async () => {
    const value = await measure(ledger, 'unpaid_supplier_invoices', {})
    const report = await generateSupplierLedger(ledger.supabase, CO)
    expect(value.value).toBe(report.total_outstanding)
    expect(value.count).toBe(report.unpaid_count)
    expect(value).toMatchObject({ value: 10000, count: 1 })
  })
})

describe('coverage', () => {
  it('has a parity case for every registered measure', () => {
    // Runs last in the file: every case above has added its measure.
    expect([...REGISTERED_MEASURE_IDS].filter((id) => !covered.has(id))).toEqual([])
  })
})
