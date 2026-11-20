/**
 * The Likviditetsprognos page's reading of a forecast: weeks with the flows
 * behind them, the chart's points, where each flow links, the warning line
 * and how far to trust the opening balance. The page renders what these say.
 */
import { describe, expect, it } from 'vitest'
import {
  chartPoints,
  defaultThreshold,
  firstBreach,
  flowHref,
  forecastTotals,
  isoWeekNumber,
  openingState,
  weekSections,
} from '../report-view'
import type { CashFlow, CashForecast, ForecastOpening } from '../types'

function flow(over: Partial<CashFlow>): CashFlow {
  return {
    date: '2026-10-29',
    direction: 'in',
    amount: 1000,
    kind: 'known',
    source: 'customer_invoice',
    estimate: false,
    counterparty: null,
    reference: null,
    ref: null,
    confidence: null,
    ...over,
  }
}

const opening: ForecastOpening = { amount: 100000, source: 'bank', as_of: '2026-10-29T05:00:00Z', age_days: 0, accounts: [] }

/** Two weeks from Thursday 2026-10-29: W44 (26 Oct - 1 Nov) and W45 (2 - 8 Nov). */
function forecast(over: Partial<CashForecast> = {}): CashForecast {
  return {
    currency: 'SEK',
    today: '2026-10-29',
    horizon: { start: '2026-10-29', end: '2026-11-08', weeks: 2 },
    opening,
    days: [
      { date: '2026-10-29', opening: 100000, inflow: 20000, outflow: 0, closing: 120000, lowest: false },
      { date: '2026-10-30', opening: 120000, inflow: 0, outflow: 50000, closing: 70000, lowest: false },
      { date: '2026-11-03', opening: 70000, inflow: 0, outflow: 60000, closing: 10000, lowest: true },
    ],
    weeks: [
      { iso_week: '2026-W44', start: '2026-10-26', end: '2026-11-01', opening: 100000, inflow: 20000, outflow: 50000, closing: 70000, min_closing: 70000, lowest: false },
      { iso_week: '2026-W45', start: '2026-11-02', end: '2026-11-08', opening: 70000, inflow: 0, outflow: 60000, closing: 10000, min_closing: 10000, lowest: true },
    ],
    lowest: { date: '2026-11-03', closing: 10000, iso_week: '2026-W45' },
    closing: 10000,
    flows: [
      flow({ date: '2026-10-30', direction: 'out', amount: 50000, source: 'supplier_invoice', ref: { type: 'supplier_invoice', id: 'si-1' } }),
      flow({ date: '2026-10-29', direction: 'in', amount: 20000, ref: { type: 'invoice', id: 'inv-1' } }),
      flow({ date: '2026-11-03', direction: 'out', amount: 40000, source: 'salary_run', ref: { type: 'salary_run', id: 'run-1' } }),
      flow({ date: '2026-11-03', direction: 'out', amount: 20000, source: 'vat', kind: 'derived', estimate: true, ref: { type: 'vat_period', id: '2026-Q3' } }),
    ],
    overdue: { receivables: { total: 0, invoices: [] }, payables: { total: 0, invoices: [] } },
    complete: true,
    caveats: [],
    ...over,
  }
}

describe('flowHref', () => {
  it('opens the invoice, the supplier invoice, the salary run, the queue and the recurring invoices', () => {
    expect(flowHref(flow({ ref: { type: 'invoice', id: 'inv-1' } }))).toBe('/invoices/inv-1')
    expect(flowHref(flow({ source: 'supplier_invoice', ref: { type: 'supplier_invoice', id: 'si-1' } }))).toBe('/supplier-invoices/si-1')
    expect(flowHref(flow({ source: 'salary_run', ref: { type: 'salary_run', id: 'run-1' } }))).toBe('/salary/runs/run-1')
    expect(flowHref(flow({ source: 'payment_order', ref: { type: 'payment_order', id: 'po-1' } }))).toBe('/payments')
    expect(flowHref(flow({ source: 'recurring_invoice', ref: { type: 'recurring_invoice_schedule', id: 's-1' } }))).toBe('/invoices/recurring')
  })

  it('sends every tax to the skattekonto, F-skatt included, though it carries no ref', () => {
    expect(flowHref(flow({ source: 'skattekonto', ref: { type: 'skattekonto', id: 'saldo' } }))).toBe('/skattekonto')
    expect(flowHref(flow({ source: 'vat', ref: { type: 'vat_period', id: '2026-Q3' } }))).toBe('/skattekonto')
    expect(flowHref(flow({ source: 'agi', ref: { type: 'agi_period', id: '2026-10' } }))).toBe('/skattekonto')
    expect(flowHref(flow({ source: 'f_skatt', ref: null }))).toBe('/skattekonto')
  })

  it('has no link for a forecast row or an estimate with nothing behind it', () => {
    expect(flowHref(flow({ source: 'forecast_row', kind: 'forecast', ref: { type: 'cash_forecast_row', id: 'r-1' } }))).toBeNull()
    expect(flowHref(flow({ source: 'salary_estimate', ref: null }))).toBeNull()
  })

  it('escapes the id', () => {
    expect(flowHref(flow({ ref: { type: 'invoice', id: 'a/b' } }))).toBe('/invoices/a%2Fb')
  })
})

describe('weekSections', () => {
  it('puts each flow in its week, money in first and the largest first on a day', () => {
    const sections = weekSections(forecast(), null)
    expect(sections.map((s) => [s.week, s.flows.map((f) => `${f.date} ${f.direction} ${f.amount}`)])).toEqual([
      [44, ['2026-10-29 in 20000', '2026-10-30 out 50000']],
      [45, ['2026-11-03 out 40000', '2026-11-03 out 20000']],
    ])
  })

  it('keeps the engine\'s figures and flags the weeks under the line', () => {
    const sections = weekSections(forecast(), 50000)
    expect(sections.map((s) => [s.opening, s.inflow, s.outflow, s.closing, s.lowest, s.belowThreshold])).toEqual([
      [100000, 20000, 50000, 70000, false, false],
      [70000, 0, 60000, 10000, true, true],
    ])
    expect(weekSections(forecast(), null).every((s) => !s.belowThreshold)).toBe(true)
  })
})

describe('chartPoints', () => {
  it('draws out below zero and the closing balance as it is', () => {
    expect(chartPoints(forecast())).toEqual([
      { iso_week: '2026-W44', week: 44, inflow: 20000, outflow: -50000, closing: 70000 },
      { iso_week: '2026-W45', week: 45, inflow: 0, outflow: -60000, closing: 10000 },
    ])
  })
})

describe('the warning line', () => {
  it('defaults to a month of the horizon\'s outgoing payments, in whole kronor', () => {
    // 110 000 out over 11 days, times 365/12 days: 304 166,67.
    expect(defaultThreshold(forecast())).toBe(304167)
    expect(defaultThreshold(forecast({ weeks: forecast().weeks.map((w) => ({ ...w, outflow: 0 })) }))).toBe(0)
  })

  it('finds the first week under the line, with the day when the daily rows show it', () => {
    expect(firstBreach(forecast(), 50000)).toEqual({ iso_week: '2026-W45', week: 45, date: '2026-11-03' })
    expect(firstBreach(forecast(), 80000)).toEqual({ iso_week: '2026-W44', week: 44, date: '2026-10-30' })
    expect(firstBreach(forecast(), 5000)).toBeNull()
    // Past the 30 daily rows only the week is known.
    expect(firstBreach(forecast({ days: [] }), 50000)).toEqual({ iso_week: '2026-W45', week: 45, date: null })
  })
})

describe('openingState', () => {
  it('trusts a fresh bank balance and says when it is old, booked or missing', () => {
    expect(openingState(opening)).toBe('bank')
    expect(openingState({ ...opening, age_days: 3 })).toBe('bank')
    expect(openingState({ ...opening, age_days: 4 })).toBe('bank_stale')
    expect(openingState({ ...opening, source: 'booked', age_days: null })).toBe('booked')
    expect(openingState({ ...opening, source: 'unknown', as_of: null, age_days: null })).toBe('unknown')
  })
})

describe('forecastTotals', () => {
  it('sums in and out over the weeks the table shows', () => {
    expect(forecastTotals(forecast())).toEqual({ inflow: 20000, outflow: 110000 })
  })
})

describe('isoWeekNumber', () => {
  it('reads the week of a label', () => {
    expect(isoWeekNumber('2026-W44')).toBe(44)
    expect(isoWeekNumber('2027-W01')).toBe(1)
  })
})
