/**
 * Each adapter's share of "count each krona once" (accounted#136): what a
 * source projects, and what it leaves to another source.
 */
import { describe, expect, it } from 'vitest'
import { addDaysIso } from '@/lib/dates/iso'
import type { ARLedgerReport } from '@/lib/reports/ar-ledger'
import type { SupplierLedgerReport } from '@/lib/reports/supplier-ledger'
import { createTableMockSupabase } from '@/tests/helpers'
import { forecastRowFlows, loadOpenForecastRows, type ForecastRowForProjection } from '../adapters/forecast-rows'
import { payableFlows, receivableFlows } from '../adapters/invoices'
import { openingFromBankBalances } from '../adapters/opening'
import { paymentOrderFlows, skattekontoPaymentsInFlight, type PaymentOrderRow } from '../adapters/payment-orders'
import { recurringFlows, recurringRunTotal, type RecurringScheduleRow } from '../adapters/recurring'
import { salaryFlows, type SalaryRunRow } from '../adapters/salary'
import { fSkattDueDates, taxCharges, taxOutflows, type TaxCharge } from '../adapters/tax'
import { forecastEnd } from '../calendar'

const TODAY = '2026-10-28'
const WINDOW = { today: TODAY, end: forecastEnd(TODAY, 13) }

function arReport(invoices: Array<{ id: string; due: string; outstanding: number | null }>): ARLedgerReport {
  return {
    entries: [
      {
        customer_id: 'c1',
        customer_name: 'Kund AB',
        invoices: invoices.map((i) => ({
          invoice_id: i.id,
          invoice_number: `F-${i.id}`,
          invoice_date: '2026-10-01',
          due_date: i.due,
          total: i.outstanding ?? 0,
          paid_amount: 0,
          outstanding: i.outstanding ?? 0,
          outstanding_sek: i.outstanding,
          days_overdue: 0,
          currency: 'SEK',
        })),
        current: 0,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 0,
      },
    ],
    total_outstanding: 0,
    total_current: 0,
    total_overdue: 0,
    unpaid_count: 0,
    unconverted_fx_count: 0,
  } as unknown as ARLedgerReport
}

function apReport(invoices: Array<{ id: string; due: string; outstanding: number }>): SupplierLedgerReport {
  return {
    entries: [
      {
        supplier_id: 's1',
        supplier_name: 'Städbolaget AB',
        invoices: invoices.map((i) => ({
          supplier_invoice_id: i.id,
          supplier_invoice_number: `L-${i.id}`,
          arrival_number: 1,
          invoice_date: '2026-10-01',
          due_date: i.due,
          currency: 'SEK',
          outstanding: i.outstanding,
          outstanding_sek: i.outstanding,
          days_overdue: 0,
        })),
        current: 0,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 0,
      },
    ],
    total_outstanding: 0,
    total_current: 0,
    total_overdue: 0,
    unpaid_count: 0,
    unconverted_fx_count: 0,
  }
}

function order(overrides: Partial<PaymentOrderRow>): PaymentOrderRow {
  return {
    id: 'po-1',
    purpose: 'supplier_invoice',
    status: 'approved',
    amount: 1000,
    currency: 'SEK',
    requested_execution_date: '2026-11-05',
    supplier_invoice_id: 'si-1',
    salary_run_id: null,
    cash_account_id: 'ca-1',
    payee_name: 'Städbolaget AB',
    reference: '4471',
    executed_at: null,
    matched_at: null,
    ...overrides,
  }
}

describe('opening balance', () => {
  const account = (overrides: Record<string, unknown>) => ({
    id: 'ca-1',
    name: 'Företagskonto',
    ledger_account: '1930',
    currency: 'SEK',
    balance: 1000,
    balance_updated_at: '2026-10-26T06:00:00Z',
    enabled: true,
    kind: 'bank',
    ...overrides,
  })

  it('sums the SEK bank balances the banks reported, with the oldest one as its age', () => {
    const r = openingFromBankBalances(
      [
        account({}),
        account({ id: 'ca-2', ledger_account: '1940', balance: '250.55', balance_updated_at: '2026-10-28T05:00:00Z' }),
        account({ id: 'ca-3', ledger_account: '1941', currency: 'EUR', balance: 99 }),
        account({ id: 'ca-4', ledger_account: '2890', kind: 'card', balance: -500 }),
        account({ id: 'ca-5', ledger_account: '1950', balance: null }),
      ],
      TODAY,
    )
    expect(r.opening).toMatchObject({ amount: 1250.55, source: 'bank', as_of: '2026-10-26T06:00:00Z', age_days: 2 })
    expect(r.opening!.accounts.map((a) => a.ledger_account)).toEqual(['1930', '1940'])
    expect(r.caveats.map((c) => c.code)).toEqual(['FOREIGN_CURRENCY_ACCOUNTS_LEFT_OUT', 'BANK_ACCOUNTS_WITHOUT_BALANCE'])
    expect(r.balanceTimes.get('ca-2')).toBe('2026-10-28T05:00:00Z')
  })

  it('answers no opening when no bank account has a reported balance, so the booked one is used', () => {
    expect(openingFromBankBalances([account({ balance: null })], TODAY).opening).toBeNull()
  })
})

describe('receivables', () => {
  it('projects open invoices on their due date and lists overdue ones apart', () => {
    const r = receivableFlows(
      arReport([
        { id: 'a', due: '2026-11-15', outstanding: 1250 },
        { id: 'b', due: '2026-10-20', outstanding: 500 },
        { id: 'c', due: '2027-03-01', outstanding: 99 },
        { id: 'd', due: '2026-11-15', outstanding: -200 },
        { id: 'e', due: '2026-11-15', outstanding: null },
      ]),
      WINDOW,
    )
    expect(r.flows).toEqual([expect.objectContaining({ date: '2026-11-15', direction: 'in', amount: 1250, kind: 'known', ref: { type: 'invoice', id: 'a' } })])
    expect(r.overdue).toEqual([expect.objectContaining({ invoice_id: 'b', days_overdue: 8, amount: 500 })])
    expect(r.caveats.map((c) => c.code)).toEqual(['RECEIVABLES_WITHOUT_RATE'])
  })
})

describe('payment queue and supplier invoices', () => {
  it('counts an invoice inside a payment order at the order date, and only the rest at its due date', () => {
    const queue = paymentOrderFlows([order({ amount: 600 })], WINDOW, new Map())
    const ap = payableFlows(apReport([{ id: 'si-1', due: '2026-11-20', outstanding: 1000 }]), queue.coverage.supplierInvoices, WINDOW)
    expect(queue.flows).toEqual([expect.objectContaining({ date: '2026-11-05', amount: 600, source: 'payment_order' })])
    expect(ap.flows).toEqual([expect.objectContaining({ date: '2026-11-20', amount: 400, source: 'supplier_invoice' })])
    const total = [...queue.flows, ...ap.flows].reduce((s, f) => s + f.amount, 0)
    expect(total).toBe(1000)
  })

  it('drops a fully covered invoice, and lists an overdue invoice no order covers', () => {
    const queue = paymentOrderFlows([order({ amount: 1000 })], WINDOW, new Map())
    const ap = payableFlows(
      apReport([
        { id: 'si-1', due: '2026-11-20', outstanding: 1000 },
        { id: 'si-2', due: '2026-10-01', outstanding: 300 },
      ]),
      queue.coverage.supplierInvoices,
      WINDOW,
    )
    expect(ap.flows).toEqual([])
    expect(ap.overdue).toEqual([expect.objectContaining({ supplier_invoice_id: 'si-2', amount: 300, days_overdue: 27 })])
  })

  it('counts an invoice due today as on time, on both ledgers, and the day before it as overdue', () => {
    const receivables = receivableFlows(
      arReport([
        { id: 'today', due: WINDOW.today, outstanding: 100 },
        { id: 'yesterday', due: addDaysIso(WINDOW.today, -1), outstanding: 200 },
      ]),
      WINDOW,
    )
    expect(receivables.flows.map((flow) => flow.ref)).toEqual([{ type: 'invoice', id: 'today' }])
    expect(receivables.overdue).toEqual([expect.objectContaining({ invoice_id: 'yesterday', days_overdue: 1 })])

    const payables = payableFlows(
      apReport([
        { id: 'today', due: WINDOW.today, outstanding: 100 },
        { id: 'yesterday', due: addDaysIso(WINDOW.today, -1), outstanding: 200 },
      ]),
      new Map(),
      WINDOW,
    )
    expect(payables.flows).toHaveLength(1)
    expect(payables.overdue).toEqual([expect.objectContaining({ supplier_invoice_id: 'yesterday', days_overdue: 1 })])
  })

  it('moves an order whose date passed to today, and leaves out cancelled, settled and foreign ones', () => {
    const queue = paymentOrderFlows(
      [
        order({ id: 'late', requested_execution_date: '2026-10-20' }),
        order({ id: 'gone', status: 'cancelled' }),
        order({ id: 'settled', status: 'executed', executed_at: '2026-10-27T10:00:00Z', matched_at: '2026-10-27T12:00:00Z' }),
        order({ id: 'eur', currency: 'EUR', supplier_invoice_id: 'si-9' }),
      ],
      WINDOW,
      new Map(),
    )
    expect(queue.flows.map((f) => [f.ref?.id, f.date])).toEqual([['late', TODAY]])
    expect(queue.coverage.supplierInvoices.has('si-9')).toBe(false)
    expect(queue.caveats.map((c) => c.code)).toEqual(['FOREIGN_CURRENCY_PAYMENTS_LEFT_OUT'])
  })

  it('treats an executed payment as in the opening when the bank reported its balance after it, and as out today when before', () => {
    const executed = order({ status: 'executed', executed_at: '2026-10-27T10:00:00Z' })
    const fresh = paymentOrderFlows([executed], WINDOW, new Map([['ca-1', '2026-10-28T05:00:00Z']]))
    expect(fresh.flows).toEqual([])
    expect(fresh.coverage.supplierInvoices.get('si-1')).toBe(1000)
    const stale = paymentOrderFlows([executed], WINDOW, new Map([['ca-1', '2026-10-27T05:00:00Z']]))
    expect(stale.flows).toEqual([expect.objectContaining({ date: TODAY, amount: 1000 })])
  })

  it('lets a skattekonto draft pay nothing, as Hem counts it', () => {
    const queue = paymentOrderFlows(
      [
        order({ id: 'draft', purpose: 'skattekonto', status: 'draft', supplier_invoice_id: null }),
        order({ id: 'sent', purpose: 'skattekonto', status: 'accepted', supplier_invoice_id: null, amount: 700 }),
      ],
      WINDOW,
      new Map(),
    )
    expect(queue.flows.map((f) => f.ref?.id)).toEqual(['sent'])
    expect(skattekontoPaymentsInFlight(queue.skattekontoOrders, null)).toBe(700)
  })
})

describe('salary', () => {
  const run = (overrides: Partial<SalaryRunRow>): SalaryRunRow => ({
    id: 'run-11',
    period_year: 2026,
    period_month: 11,
    payment_date: '2026-11-25',
    status: 'approved',
    total_net: 30000,
    total_tax: 12000,
    total_avgifter: 13196,
    is_correction: false,
    ...overrides,
  })

  it('counts a run once as net pay, less what salary payment orders already pay, and hands tax and avgifter to the AGI', () => {
    const r = salaryFlows({
      runs: [run({})],
      basisRun: run({ id: 'run-10', period_month: 10, payment_date: '2026-10-25', status: 'paid' }),
      employees: [],
      payDay: 25,
      avgifterRate: null,
      covered: new Map([['run-11', 10000]]),
      window: WINDOW,
    })
    const known = r.flows.filter((f) => f.source === 'salary_run')
    expect(known).toEqual([expect.objectContaining({ date: '2026-11-25', amount: 20000, kind: 'known', estimate: false })])
    expect(r.taxBasis.get('2026-11')).toEqual({ tax: 12000, avgifter: 13196, estimate: false })
  })

  it('estimates each month without a run from the latest run, and says so', () => {
    const r = salaryFlows({
      runs: [run({})],
      basisRun: run({ id: 'run-10', period_month: 10, payment_date: '2026-10-25', status: 'paid', total_net: 29000 }),
      employees: [],
      payDay: 25,
      avgifterRate: null,
      covered: new Map(),
      window: WINDOW,
    })
    const estimated = r.flows.filter((f) => f.source === 'salary_estimate')
    // January's pay day (the 25th) falls after the last week (Sunday 24 January).
    expect(estimated.map((f) => [f.date, f.amount, f.estimate, f.kind])).toEqual([['2026-12-25', 29000, true, 'derived']])
    expect(r.taxBasis.get('2026-12')).toEqual({ tax: 12000, avgifter: 13196, estimate: true })
    expect(r.caveats.map((c) => c.code)).toEqual(['SALARY_ESTIMATED'])
  })

  it('estimates from the employee register when there is no run: gross, 30 % tax, avgifter at the year rate', () => {
    const r = salaryFlows({
      runs: [],
      basisRun: null,
      employees: [
        { id: 'e1', salary_type: 'monthly', monthly_salary: 40000, employment_degree: 100, employment_start: '2025-01-01', employment_end: null },
        { id: 'e2', salary_type: 'monthly', monthly_salary: 30000, employment_degree: 50, employment_start: '2025-01-01', employment_end: '2026-11-30' },
        { id: 'e3', salary_type: 'hourly', monthly_salary: null, employment_degree: 100, employment_start: '2025-01-01', employment_end: null },
      ],
      payDay: 25,
      avgifterRate: 0.3142,
      covered: new Map(),
      window: WINDOW,
    })
    expect(r.flows.map((f) => [f.date, f.amount])).toEqual([
      ['2026-11-25', 38500],
      ['2026-12-25', 28000],
    ])
    expect(r.taxBasis.get('2026-11')).toEqual({ tax: 16500, avgifter: 17281, estimate: true })
    expect(r.caveats.map((c) => c.code)).toEqual(['SALARY_ESTIMATED', 'SALARY_HOURLY_NOT_ESTIMATED'])
  })

  it('estimates a month whose run is an uncalculated draft, and skips a month whose pay day has passed', () => {
    const r = salaryFlows({
      runs: [run({ status: 'draft', total_net: 0, total_tax: 0, total_avgifter: 0 })],
      basisRun: run({ id: 'run-10', status: 'paid' }),
      employees: [],
      payDay: 20,
      avgifterRate: null,
      covered: new Map(),
      window: WINDOW,
    })
    // October's 20th has passed; November's draft is not a run yet.
    expect(r.flows.map((f) => [f.date, f.source])).toEqual([
      ['2026-11-20', 'salary_estimate'],
      ['2026-12-20', 'salary_estimate'],
      ['2027-01-20', 'salary_estimate'],
    ])
  })
})

describe('taxes', () => {
  const base = {
    synced: false,
    upcoming: [],
    fSkattMonthly: null,
    fSkattDueDates: [],
    vat: [],
    agi: [],
    salaryBasis: new Map(),
    window: WINDOW,
  }

  it('leaves filed declarations and preliminary tax to Skatteverket\'s own debits on a synced skattekonto', () => {
    const charges = taxCharges({
      ...base,
      synced: true,
      upcoming: [
        { due_date: '2026-11-12', amount: -5000, text: 'Debiterad preliminärskatt' },
        { due_date: '2026-11-12', amount: -20000, text: 'Moms sep 2026' },
        { due_date: '2026-11-12', amount: 300, text: 'Intäktsränta' },
      ],
      fSkattMonthly: 5000,
      fSkattDueDates: ['2026-11-12', '2026-12-14'],
      vat: [
        { period: '2026-09', due_date: '2026-11-12', declared: 20000, filed: true, open: false },
        { period: '2026-10', due_date: '2026-12-14', declared: 18000, filed: false, open: false },
      ],
      agi: [{ month: '2026-10', due_date: '2026-11-12', declared: 25196, filed: true, paid: false }],
    })
    expect(charges.map((c) => [c.source, c.due_date, c.amount, c.estimate])).toEqual([
      ['skattekonto', '2026-11-12', 5000, false],
      ['skattekonto', '2026-11-12', 20000, false],
      // December's preliminary tax is not in Skatteverket's list yet: from the settings.
      ['f_skatt', '2026-12-14', 5000, false],
      // Not filed: the books so far, an estimate.
      ['vat', '2026-12-14', 18000, true],
    ])
  })

  it('without a synced skattekonto, counts filed declarations, F-skatt and the AGI from runs or the estimate', () => {
    const charges = taxCharges({
      ...base,
      fSkattMonthly: 5000,
      fSkattDueDates: ['2026-11-12'],
      vat: [{ period: '2026-Q3', due_date: '2026-11-12', declared: 42000, filed: true, open: false }],
      agi: [
        { month: '2026-10', due_date: '2026-11-12', declared: null, filed: false, paid: false },
        { month: '2026-11', due_date: '2026-12-14', declared: null, filed: false, paid: false },
        { month: '2026-09', due_date: '2026-10-12', declared: 1, filed: true, paid: false },
        { month: '2026-12', due_date: '2027-01-18', declared: 900, filed: true, paid: true },
      ],
      salaryBasis: new Map([
        ['2026-10', { tax: 12000, avgifter: 13196, estimate: false }],
        ['2026-11', { tax: 11000, avgifter: 12000, estimate: true }],
      ]),
    })
    expect(charges.map((c) => [c.source, c.due_date, c.amount, c.kind, c.estimate])).toEqual([
      ['f_skatt', '2026-11-12', 5000, 'known', false],
      ['vat', '2026-11-12', 42000, 'known', false],
      ['agi', '2026-11-12', 25196, 'derived', false],
      ['agi', '2026-12-14', 23000, 'derived', true],
    ])
  })

  it('meets each charge first from the skattekonto saldo and payments under way, in due order', () => {
    const charge = (due: string, amount: number): TaxCharge => ({ due_date: due, amount, kind: 'known', source: 'vat', estimate: false, reference: null, ref: null })
    const flows = taxOutflows([charge('2026-12-14', 10000), charge('2026-11-12', 6000), charge('2026-10-01', 100)], 7000, WINDOW)
    // 7000 covers the overdue 100 and the 6000 of November, then 900 of December.
    expect(flows.map((f) => [f.date, f.amount])).toEqual([['2026-12-14', 9100]])
  })

  it('places F-skatt on the 12th, the 17th in January, moved to a banking day', () => {
    expect(fSkattDueDates(WINDOW, { vat_registered: true, vat_taxable_base_over_40m: false })).toEqual([
      '2026-11-12',
      '2026-12-14',
      '2027-01-18',
    ])
  })
})

describe('recurring invoices', () => {
  const schedule = (overrides: Partial<RecurringScheduleRow> = {}): RecurringScheduleRow => ({
    id: 'rs-1',
    name: 'Hyra lokal',
    day_of_month: 1,
    interval_months: 1,
    payment_terms_days: 30,
    currency: 'SEK',
    next_run_date: '2026-11-01',
    customer: { name: 'Kund AB', customer_type: 'swedish_business', vat_number_validated: false, country: 'SE' },
    items: [
      { quantity: 2, unit_price: 500, vat_rate: 25 },
      { line_type: 'text', quantity: 1, unit_price: 0, vat_rate: null },
    ],
    ...overrides,
  })

  it('totals a run the way the cron does: VAT at the line rate, none when not VAT-registered', () => {
    expect(recurringRunTotal(schedule(), true)).toBe(1250)
    expect(recurringRunTotal(schedule(), false)).toBe(1000)
  })

  it('expects each run inside the horizon on run date + payment terms', () => {
    const r = recurringFlows([schedule(), schedule({ id: 'rs-eur', currency: 'EUR' })], true, WINDOW)
    expect(r.flows.map((f) => [f.date, f.amount, f.kind])).toEqual([
      ['2026-12-01', 1250, 'derived'],
      ['2026-12-31', 1250, 'derived'],
    ])
    expect(r.caveats.map((c) => c.code)).toEqual(['FOREIGN_CURRENCY_SCHEDULES_LEFT_OUT'])
  })
})

describe('forecast rows', () => {
  const row = (overrides: Partial<ForecastRowForProjection>): ForecastRowForProjection => ({
    id: 'r1',
    expected_date: '2026-11-20',
    amount: 48000,
    direction: 'in',
    category: 'revenue',
    confidence: 'likely',
    invoice_id: null,
    supplier_invoice_id: null,
    external_source: 'boom',
    note: 'Bokning vecka 47',
    ...overrides,
  })

  it('counts open rows on their date, yields to a linked invoice and reports rows dated before today', () => {
    const r = forecastRowFlows(
      [row({}), row({ id: 'linked', invoice_id: 'inv-1' }), row({ id: 'linked-ap', supplier_invoice_id: 'si-1', direction: 'out' }), row({ id: 'old', expected_date: '2026-10-01' })],
      WINDOW,
      2,
    )
    expect(r.flows).toEqual([
      expect.objectContaining({ date: '2026-11-20', amount: 48000, kind: 'forecast', source: 'forecast_row', confidence: 'likely', ref: { type: 'cash_forecast_row', id: 'r1' } }),
    ])
    expect(r.caveats).toEqual([expect.objectContaining({ code: 'FORECAST_ROWS_PAST', message_en: expect.stringMatching(/^3 open forecast row/) })])
  })

  it('counts as past only the open rows no invoice took over', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ cash_forecast_rows: { data: [], count: 2 } })
    const loaded = await loadOpenForecastRows(supabase as never, 'company-1', WINDOW)
    expect(loaded).toEqual({ rows: [], pastOpenRows: 2 })
    expect(findCalls('cash_forecast_rows', 'is')).toEqual([
      ['invoice_id', null],
      ['supplier_invoice_id', null],
    ])
    expect(findCalls('cash_forecast_rows', 'lt')).toEqual([['expected_date', TODAY]])
  })
})
