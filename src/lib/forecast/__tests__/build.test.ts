/**
 * buildCashForecast composes the adapters: the opening, then every source,
 * each krona once across them, and a source that cannot be read becomes a
 * caveat instead of a failed forecast. The loaders are replaced; the pure
 * rules run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ARLedgerReport } from '@/lib/reports/ar-ledger'
import type { SupplierLedgerReport } from '@/lib/reports/supplier-ledger'

const loaders = vi.hoisted(() => ({
  loadOpening: vi.fn(),
  loadPaymentOrders: vi.fn(),
  loadReceivablesReport: vi.fn(),
  loadPayablesReport: vi.fn(),
  loadSalaryInputs: vi.fn(),
  loadTaxInputs: vi.fn(),
  loadRecurringSchedules: vi.fn(),
  loadOpenForecastRows: vi.fn(),
}))

vi.mock('../adapters/opening', async (orig) => ({ ...(await orig<object>()), loadOpening: loaders.loadOpening }))
vi.mock('../adapters/payment-orders', async (orig) => ({ ...(await orig<object>()), loadPaymentOrders: loaders.loadPaymentOrders }))
vi.mock('../adapters/invoices', async (orig) => ({
  ...(await orig<object>()),
  loadReceivablesReport: loaders.loadReceivablesReport,
  loadPayablesReport: loaders.loadPayablesReport,
}))
vi.mock('../adapters/salary', async (orig) => ({ ...(await orig<object>()), loadSalaryInputs: loaders.loadSalaryInputs }))
vi.mock('../adapters/tax', async (orig) => ({ ...(await orig<object>()), loadTaxInputs: loaders.loadTaxInputs }))
vi.mock('../adapters/recurring', async (orig) => ({ ...(await orig<object>()), loadRecurringSchedules: loaders.loadRecurringSchedules }))
vi.mock('../adapters/forecast-rows', async (orig) => ({ ...(await orig<object>()), loadOpenForecastRows: loaders.loadOpenForecastRows }))

import { buildCashForecast } from '../build'

const TODAY = '2026-10-28'
const supabase = {} as never

const emptyLedger = { entries: [], total_outstanding: 0, total_current: 0, total_overdue: 0, unpaid_count: 0, unconverted_fx_count: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  loaders.loadOpening.mockResolvedValue({
    opening: { amount: 100000, source: 'bank', as_of: '2026-10-28T05:00:00Z', age_days: 0, accounts: [] },
    caveats: [],
    balanceTimes: new Map([['ca-1', '2026-10-28T05:00:00Z']]),
  })
  loaders.loadPaymentOrders.mockResolvedValue([])
  loaders.loadReceivablesReport.mockResolvedValue(emptyLedger as unknown as ARLedgerReport)
  loaders.loadPayablesReport.mockResolvedValue(emptyLedger as SupplierLedgerReport)
  loaders.loadSalaryInputs.mockResolvedValue({ runs: [], basisRun: null, employees: [], payDay: 25, avgifterRate: null, caveats: [] })
  loaders.loadTaxInputs.mockResolvedValue({
    synced: true,
    saldo: 0,
    snapshotFetchedAtMs: null,
    upcoming: [],
    fSkattMonthly: null,
    fSkattDueDates: [],
    vat: [],
    agi: [],
    caveats: [],
  })
  loaders.loadRecurringSchedules.mockResolvedValue({ schedules: [], vatRegistered: true })
  loaders.loadOpenForecastRows.mockResolvedValue({ rows: [], pastOpenRows: 0 })
})

describe('buildCashForecast', () => {
  it('counts a supplier invoice in a payment order once, at the order date, and a salary run as net pay with its tax via the skattekonto', async () => {
    loaders.loadPaymentOrders.mockResolvedValue([
      {
        id: 'po-1', purpose: 'supplier_invoice', status: 'approved', amount: 4000, currency: 'SEK', requested_execution_date: '2026-11-02',
        supplier_invoice_id: 'si-1', salary_run_id: null, cash_account_id: 'ca-1', payee_name: 'Städbolaget AB', reference: '4471', executed_at: null, matched_at: null,
      },
    ])
    loaders.loadPayablesReport.mockResolvedValue({
      ...emptyLedger,
      entries: [
        {
          supplier_id: 's1', supplier_name: 'Städbolaget AB', current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0, total_outstanding: 4000,
          invoices: [{ supplier_invoice_id: 'si-1', supplier_invoice_number: '4471', arrival_number: 1, invoice_date: '2026-10-10', due_date: '2026-11-09', currency: 'SEK', outstanding: 4000, outstanding_sek: 4000, days_overdue: 0 }],
        },
      ],
    })
    loaders.loadSalaryInputs.mockResolvedValue({
      runs: [{ id: 'run-11', period_year: 2026, period_month: 11, payment_date: '2026-11-25', status: 'approved', total_net: 30000, total_tax: 12000, total_avgifter: 13196, is_correction: false }],
      basisRun: null, employees: [], payDay: 25, avgifterRate: null, caveats: [],
    })
    loaders.loadTaxInputs.mockResolvedValue({
      synced: false, saldo: 0, snapshotFetchedAtMs: null, upcoming: [], fSkattMonthly: null, fSkattDueDates: [], vat: [],
      agi: [{ month: '2026-11', due_date: '2026-12-14', declared: null, filed: false, paid: false }], caveats: [],
    })

    const forecast = await buildCashForecast(supabase, 'company-1', { today: TODAY, weeks: 13 })
    expect(forecast.flows.map((f) => [f.date, f.source, f.amount])).toEqual([
      ['2026-11-02', 'payment_order', 4000],
      ['2026-11-25', 'salary_run', 30000],
      ['2026-12-14', 'agi', 25196],
    ])
    expect(forecast.closing).toBe(100000 - 4000 - 30000 - 25196)
    expect(forecast.lowest).toMatchObject({ closing: 40804, date: '2026-12-14' })
    expect(forecast.complete).toBe(true)
    expect(forecast.horizon).toEqual({ start: TODAY, end: '2027-01-24', weeks: 13 })
    expect(forecast.days).toHaveLength(30)
    expect(forecast.weeks).toHaveLength(13)
  })

  it('meets tax charges from the skattekonto saldo and a payment to it under way, and asks for a debt today', async () => {
    loaders.loadPaymentOrders.mockResolvedValue([
      {
        id: 'po-skv', purpose: 'skattekonto', status: 'approved', amount: 5000, currency: 'SEK', requested_execution_date: '2026-11-10',
        supplier_invoice_id: null, salary_run_id: null, cash_account_id: 'ca-1', payee_name: 'Skatteverket', reference: '1655', executed_at: null, matched_at: null,
      },
    ])
    loaders.loadTaxInputs.mockResolvedValue({
      synced: true, saldo: -8000, snapshotFetchedAtMs: Date.parse('2026-10-28T04:00:00Z'),
      upcoming: [{ due_date: '2026-11-12', amount: -6000, text: 'Debiterad preliminärskatt' }],
      fSkattMonthly: null, fSkattDueDates: [], vat: [], agi: [], caveats: [],
    })
    const forecast = await buildCashForecast(supabase, 'company-1', { today: TODAY })
    // Saldo -8000 + 5000 under way = -3000: 3000 is owed now, and the 6000 charge is paid in on its day.
    expect(forecast.flows.map((f) => [f.date, f.source, f.amount])).toEqual([
      [TODAY, 'skattekonto', 3000],
      ['2026-11-10', 'payment_order', 5000],
      ['2026-11-12', 'skattekonto', 6000],
    ])
  })

  it('leaves a source it cannot read out, says so, and still answers', async () => {
    loaders.loadReceivablesReport.mockRejectedValue(new Error('timeout'))
    loaders.loadOpenForecastRows.mockResolvedValue({
      rows: [{ id: 'r1', expected_date: '2026-11-20', amount: 48000, direction: 'in', category: 'revenue', confidence: 'possible', invoice_id: null, supplier_invoice_id: null, external_source: 'boom', note: null }],
      pastOpenRows: 0,
    })
    const forecast = await buildCashForecast(supabase, 'company-1', { today: TODAY })
    expect(forecast.complete).toBe(false)
    expect(forecast.caveats).toContainEqual(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE', message_en: expect.stringMatching(/^Customer invoices could not be read/) }))
    expect(forecast.flows).toEqual([expect.objectContaining({ source: 'forecast_row', confidence: 'possible', amount: 48000 })])
    expect(forecast.closing).toBe(148000)
  })

  it('clamps the horizon to 1..26 weeks', async () => {
    expect((await buildCashForecast(supabase, 'company-1', { today: TODAY, weeks: 99 })).weeks).toHaveLength(26)
    expect((await buildCashForecast(supabase, 'company-1', { today: TODAY, weeks: 0 })).weeks).toHaveLength(1)
  })
})
