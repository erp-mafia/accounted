/**
 * The tax proposal of each closed year against the answer key, the declaration
 * and the årsredovisning: three readings of one result. The stock count and the
 * depreciation are booked as year_end vouchers and stand in the key's result
 * like any other line, so a proposal that left one out cannot agree with it.
 *
 * The non-deductible representation is added back before the cap and the tax
 * (IL 30 kap. 5 §: the cap is 25 % of the överskott before the avsättning).
 */
import { describe, expect, it } from 'vitest'
import { loadSimCompany } from './company'

const { state, plan, key, doors } = loadSimCompany()

const closedYears = plan.events.flatMap((event) => (event.type === 'year_end' ? [event.year] : []))

interface Row {
  label: string
  current: number | null
}

function expectKronor(actual: number, expected: number): void {
  expect(Math.abs(actual - expected), `${actual} against ${expected}`).toBeLessThanOrEqual(1)
}

describe.each(closedYears)('the tax proposal for %i', (year) => {
  const figures = key.years[year]
  const fiscal_period_id = state.fiscalPeriods[year]
  const proposal = () => doors.call('gnubok_propose_dispositioner', { fiscal_period_id })

  it('starts from the result the key gives', async () => {
    const { netResultBefore } = await proposal()
    expect(netResultBefore).toBe(figures.resultBeforeTax)
  })

  it('agrees with the declaration and the årsredovisning', async () => {
    const [{ netResultBefore }, { ink2s }, { report }] = await Promise.all([
      proposal(),
      doors.call('gnubok_get_ink2_declaration', { period_id: fiscal_period_id }),
      doors.call('gnubok_preview_arsredovisning', { fiscal_period_id }),
    ])
    const beforeTax = (report.resultatrakning as Row[]).find((row) => row.label === 'Resultat före skatt')
    expectKronor(ink2s['7650'] + ink2s['7651'] - ink2s['7750'], netResultBefore)
    expectKronor(beforeTax?.current ?? Number.NaN, netResultBefore)
  })

  it('caps the periodiseringsfond at 25 % of it and taxes what is left', async () => {
    const { proposals } = await proposal()
    const find = (kind: string) => proposals.find((item: { kind: string }) => item.kind === kind)
    // The överavskrivning the same proposal offers comes off the result first.
    const afterDepreciation = figures.resultBeforeTax - (find('overavskrivningar')?.signedAmount ?? 0)
    const surplus = afterDepreciation + figures.nonDeductibleCosts
    const avsattning = Math.floor(Math.floor(surplus) * 0.25)
    const tax = find('bolagsskatt')
    expect(find('periodiseringsfond_avsattning').amount).toBe(avsattning)
    expect(tax.computation.resultBeforeTax).toBeCloseTo(afterDepreciation - avsattning, 2)
    expect(tax.computation.nonDeductibleExpenses).toBe(figures.nonDeductibleCosts)
    expect(tax.amount).toBe(Math.round((Math.floor((surplus - avsattning) / 10) * 10) * 0.206))
  })
})
