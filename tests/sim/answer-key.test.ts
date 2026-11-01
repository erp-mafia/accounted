/**
 * The answer key checked on its own: a judge that does not balance judges
 * nothing. No database here, so this runs with the unit suite on every merge
 * request while the company itself is built nightly.
 */
import { describe, expect, it } from 'vitest'
import { computeAnswerKey, depreciationFor, monthKey, payrollFor, vatKey } from './answer-key'
import { generateCompany, type SimPlan } from './generate'

const SEED = 20240101

function planWith(events: SimPlan['events']): SimPlan {
  return { ...generateCompany(SEED, 'small'), events }
}

describe('generateCompany', () => {
  it('gives the same company for the same seed and another for another', () => {
    expect(generateCompany(SEED, 'small')).toEqual(generateCompany(SEED, 'small'))
    expect(generateCompany(SEED + 1, 'small').events).not.toEqual(generateCompany(SEED, 'small').events)
  })

  it('keeps every event in date order inside the company life', () => {
    const { events } = generateCompany(SEED, 'full')
    const dates = events.map((event) => event.date)
    expect(dates).toEqual([...dates].sort())
    expect(dates.at(-1)! <= '2026-09-30').toBe(true)
  })

  it('files moms by the deadlines: the 12th of the second month, the 17th in August', () => {
    const paid = generateCompany(SEED, 'small').events.flatMap((event) =>
      event.type === 'vat_paid' && event.year === 2024 ? [event.date.slice(0, 7)] : [],
    )
    expect(paid).toEqual(['2024-05', '2024-08', '2024-11', '2025-02'])
  })
})

describe('computeAnswerKey', () => {
  it.each(['small', 'full'] as const)('balances every year of the %s company', (scale) => {
    const key = computeAnswerKey(generateCompany(SEED, scale))
    expect(Object.keys(key.years)).toEqual(['2024', '2025', '2026'])
    for (const year of Object.values(key.years)) {
      expect(year.totalAssets).toBe(year.totalEquityAndLiabilities)
    }
  })

  it('carries each year result into the equity of the next', () => {
    const { years } = computeAnswerKey(generateCompany(SEED, 'small'))
    expect(years[2025].retainedEarnings).toBe(years[2024].result)
    expect(years[2026].retainedEarnings).toBeCloseTo(years[2024].result + years[2025].result, 2)
  })

  it('works moms out from one sale and one EU purchase, by hand', () => {
    const key = computeAnswerKey(
      planWith([
        {
          type: 'sale',
          date: '2024-02-01',
          id: 'sale-1',
          customer: 'customer-1',
          dueDate: '2024-03-01',
          lines: [
            { description: 'a', quantity: 2, unit: 'tim', unitPrice: 1001, vatRate: 25 },
            { description: 'b', quantity: 1, unit: 'st', unitPrice: 249, vatRate: 6 },
          ],
        },
        {
          type: 'purchase',
          date: '2024-02-02',
          id: 'purchase-1',
          supplier: 'cloud-ie',
          number: 'C-1',
          dueDate: '2024-03-02',
          lines: [{ description: 'c', account: '6540', net: 2_000, vatRate: 0 }],
        },
        { type: 'vat_settlement', date: '2024-03-31', year: 2024, quarter: 1 },
      ]),
    )
    expect(key.vat[vatKey(2024, 1)]).toEqual({
      ruta05: 2_251,
      ruta10: 500.5,
      ruta11: 0,
      ruta12: 14.94,
      ruta21: 2_000,
      ruta30: 500,
      ruta39: 0,
      ruta40: 0,
      ruta48: 500,
      ruta49: 515.44,
      filedNet: 514,
    })
  })

  it('pays the filed whole kronor of avgifter and keeps the öre as cost', () => {
    const plan = generateCompany(SEED, 'small')
    const september = payrollFor(plan, 2024, 9)
    expect(september.totalGross).toBe(116_000)
    expect(september.totalAvgifter).toBe(36_447.2)
    expect(september.filedAvgifter).toBe(36_447)
    expect(september.payable).toBe(september.totalTax + 36_447)
  })

  it('reads skatteavdrag from the table of the payment year', () => {
    const plan = generateCompany(SEED, 'small')
    const owner = (month: number, year: number) => payrollFor(plan, year, month).employees[0]
    // 42 000 kr in table 30, column 1: the bracket 41 801-42 000 of each year.
    expect(owner(1, 2024).tax).toBe(8_968)
    expect(computeAnswerKey(plan).payroll[monthKey(2024, 1)].totalTax).toBe(8_968)
  })

  it('books what a stock count changes, and the result before tax carries it', () => {
    const { years } = computeAnswerKey(
      planWith([
        { type: 'stock_count', date: '2024-12-31', year: 2024, value: 40_000 },
        { type: 'stock_count', date: '2025-12-31', year: 2025, value: 25_000 },
      ]),
    )
    expect(years[2024]).toMatchObject({ stock: 40_000, stockChange: -40_000, resultBeforeTax: 40_000 })
    expect(years[2025]).toMatchObject({ stock: 25_000, stockChange: 15_000, resultBeforeTax: -15_000 })
  })

  it('depreciates linearly from the purchase day, whole kronor per year', () => {
    const asset = { date: '2024-07-01', cost: 60_000, usefulLifeMonths: 60 }
    expect(depreciationFor(asset, 2024)).toBe(Math.round((12_000 * 184) / 366))
    expect(depreciationFor(asset, 2025)).toBe(12_000)
    expect(depreciationFor({ ...asset, date: '2026-01-01' }, 2025)).toBe(0)
  })
})
