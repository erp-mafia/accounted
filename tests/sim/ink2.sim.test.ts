/**
 * The INK2 of each closed year against the answer key. The declaration carries
 * whole kronor with the öre dropped, so a field may sit one krona from the key.
 */
import { describe, expect, it } from 'vitest'
import { loadSimCompany } from './company'

const { state, plan, key, doors } = loadSimCompany()

const closedYears = plan.events.flatMap((event) => (event.type === 'year_end' ? [event.year] : []))

function expectKronor(actual: number, expected: number): void {
  expect(Math.abs(actual - expected), `${actual} against ${expected}`).toBeLessThanOrEqual(1)
}

describe.each(closedYears)('INK2 %i', (year) => {
  const figures = key.years[year]
  const declaration = () => doors.call('gnubok_get_ink2_declaration', { period_id: state.fiscalPeriods[year] })

  it('carries the statements in the räkenskapsschema', async () => {
    const { ink2r } = await declaration()
    expectKronor(ink2r['7215'], figures.tangibleAssets)
    expectKronor(ink2r['7243'], figures.stock)
    expectKronor(ink2r['7251'], figures.receivables)
    expectKronor(ink2r['7281'], figures.cash)
    expectKronor(ink2r['7301'], figures.shareCapital)
    expectKronor(ink2r['7302'], figures.retainedEarnings + figures.result)
    expectKronor(ink2r['7365'], figures.supplierPayables)
    expectKronor(ink2r['7368'], figures.corporateTaxLiability)
    expectKronor(ink2r['7369'], figures.vatLiability + figures.payrollLiabilities)
    expectKronor(ink2r['7370'], figures.accruedVacation)
    expectKronor(ink2r['7410'], figures.revenue)
    expectKronor(ink2r['7512'], figures.stockChange)
    expectKronor(ink2r['7513'], figures.externalCosts)
    expectKronor(ink2r['7514'], figures.personnelCosts)
    expectKronor(ink2r['7515'], figures.depreciation)
    expectKronor(ink2r['7528'], figures.corporateTax)
    expectKronor(ink2r['7450'], figures.result)
  })

  it('starts the tax adjustments from the result and the booked tax', async () => {
    const { ink2s } = await declaration()
    expectKronor(ink2s['7650'], figures.result)
    expectKronor(ink2s['7651'], figures.corporateTax)
  })

  // Found by this suite: the product books meal representation on 6072, but
  // only 6992 and 8423 are detected as non-deductible (tax-adjustment-service),
  // so INK2S 4.3c stays 0 and the överskott is understated by the representation.
  // When this starts passing, drop `.fails`.
  it.fails('adds back the representation that gives no deduction (4.3c)', async () => {
    const { ink2s } = await declaration()
    expect(ink2s['7653']).toBe(figures.nonDeductibleCosts)
  })

  it.fails('declares the överskott the tax was paid on', async () => {
    const { ink2 } = await declaration()
    expectKronor(ink2['7104'], figures.resultBeforeTax + figures.nonDeductibleCosts)
  })
})
