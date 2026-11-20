import { describe, expect, it } from 'vitest'
import { computeBudgetVsActual, figures } from '../budget-vs-actual'

const MONTHS = ['2027-01', '2027-02', '2027-03']
const NAMES = new Map([
  ['3010', 'Försäljning tjänster'],
  ['5010', 'Lokalhyra'],
  ['6110', 'Kontorsmateriel'],
])

describe('figures', () => {
  it('deviation is actual minus budget, percent of the budget\'s size', () => {
    expect(figures(1000, 1200)).toEqual({ budget: 1000, actual: 1200, deviation: 200, deviation_percent: 20 })
    // A cost: budget -500 (resultatrapport sign), actual -600: 100 kr worse.
    expect(figures(-500, -600)).toEqual({ budget: -500, actual: -600, deviation: -100, deviation_percent: -20 })
  })

  it('has no percentage where nothing is budgeted', () => {
    expect(figures(0, 250).deviation_percent).toBeNull()
  })

  it('rounds the percentage to two decimals', () => {
    expect(figures(3, 4).deviation_percent).toBe(33.33)
  })
})

describe('computeBudgetVsActual', () => {
  const table = computeBudgetVsActual({
    months: MONTHS,
    // SIE sign in, as the budget and the ledger keep it.
    budget: [
      { account_number: '3010', month: '2027-01', amount: -10000 },
      { account_number: '3010', month: '2027-02', amount: -10000 },
      { account_number: '3010', month: '2027-03', amount: -10000 },
      { account_number: '5010', month: '2027-01', amount: 4000 },
      { account_number: '5010', month: '2027-04', amount: 4000 },
    ],
    actual: [
      { account_number: '3010', month: '2027-01', amount: -12000 },
      { account_number: '3010', month: '2027-02', amount: -9000 },
      { account_number: '6110', month: '2027-02', amount: 300 },
    ],
    accountNames: NAMES,
  })

  it('answers in the resultatrapport sign: revenue positive, costs negative', () => {
    const revenue = table.rows.find((r) => r.account_number === '3010')!
    expect(revenue.months[0]).toEqual({ month: '2027-01', budget: 10000, actual: 12000, deviation: 2000, deviation_percent: 20 })
    const rent = table.rows.find((r) => r.account_number === '5010')!
    expect(rent.months[0]).toMatchObject({ budget: -4000, actual: 0, deviation: 4000, deviation_percent: 100 })
  })

  it('lists every account with a budget or an actual in the window, by account number', () => {
    expect(table.rows.map((r) => r.account_number)).toEqual(['3010', '5010', '6110'])
    expect(table.rows.find((r) => r.account_number === '6110')!.total).toEqual({
      budget: 0,
      actual: -300,
      deviation: -300,
      deviation_percent: null,
    })
    expect(table.rows[0]!.account_name).toBe('Försäljning tjänster')
  })

  it('leaves out months outside the window', () => {
    const rent = table.rows.find((r) => r.account_number === '5010')!
    expect(rent.total.budget).toBe(-4000)
    expect(rent.months.map((m) => m.month)).toEqual(MONTHS)
  })

  it('totals each account over the window and the result over every account', () => {
    const revenue = table.rows.find((r) => r.account_number === '3010')!
    expect(revenue.total).toEqual({ budget: 30000, actual: 21000, deviation: -9000, deviation_percent: -30 })
    // Result: budget 30000 - 4000 = 26000; actual 21000 - 300 = 20700.
    expect(table.totals.total).toEqual({ budget: 26000, actual: 20700, deviation: -5300, deviation_percent: -20.38 })
    expect(table.totals.months[1]).toEqual({ month: '2027-02', budget: 10000, actual: 8700, deviation: -1300, deviation_percent: -13 })
  })

  it('is empty with nothing budgeted and nothing booked', () => {
    const empty = computeBudgetVsActual({ months: MONTHS, budget: [], actual: [], accountNames: NAMES })
    expect(empty.rows).toEqual([])
    expect(empty.totals.total).toEqual({ budget: 0, actual: 0, deviation: 0, deviation_percent: null })
    expect(empty.totals.months).toHaveLength(3)
  })
})
