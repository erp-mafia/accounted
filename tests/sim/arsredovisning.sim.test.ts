/**
 * The årsredovisning of each closed year against the answer key: the K2
 * statements, the comparison year, the equity and the compliance check.
 * Statements print whole kronor, so a row may sit one krona from the key.
 */
import { describe, expect, it } from 'vitest'
import { loadSimCompany } from './company'

const { state, plan, key, doors } = loadSimCompany()

interface Row {
  label: string
  current: number | null
  previous: number | null
  semantic_key?: string
}

const closedYears = plan.events.flatMap((event) => (event.type === 'year_end' ? [event.year] : []))

function amount(rows: Row[], label: string, column: 'current' | 'previous' = 'current'): number {
  // A heading and its one post can share a label: the post has the amount.
  const row = rows.find((candidate) => candidate.label === label && candidate.current !== null)
  if (!row) throw new Error(`no row "${label}" in ${rows.map((candidate) => candidate.label).join(', ')}`)
  return row[column] ?? 0
}

function expectKronor(actual: number, expected: number): void {
  expect(Math.abs(actual - expected), `${actual} against ${expected}`).toBeLessThanOrEqual(1)
}

describe.each(closedYears)('årsredovisning %i', (year) => {
  const figures = key.years[year]
  const previous = key.years[year - 1]
  const preview = () => doors.call('gnubok_preview_arsredovisning', { fiscal_period_id: state.fiscalPeriods[year] })

  it('has the income statement the year gives', async () => {
    const { report } = await preview()
    const rows = report.resultatrakning as Row[]
    expectKronor(amount(rows, 'Nettoomsättning'), figures.revenue)
    expectKronor(amount(rows, 'Handelsvaror'), -figures.stockChange)
    expectKronor(amount(rows, 'Övriga externa kostnader'), -figures.externalCosts)
    expectKronor(amount(rows, 'Personalkostnader'), -figures.personnelCosts)
    expectKronor(amount(rows, 'Av- och nedskrivningar av materiella och immateriella anläggningstillgångar'), -figures.depreciation)
    expectKronor(amount(rows, 'Resultat före skatt'), figures.resultBeforeTax)
    expectKronor(amount(rows, 'Skatt på årets resultat'), -figures.corporateTax)
    expectKronor(amount(rows, 'Årets resultat'), figures.result)
  })

  it('has the balance sheet the year gives, and it balances', async () => {
    const { balansrakning } = (await preview()).report as { balansrakning: Record<string, never> & { assets: Row[]; equity_liabilities: Row[]; total_assets: number; total_equity_liabilities: number } }
    expect(balansrakning.total_assets).toBe(balansrakning.total_equity_liabilities)
    expectKronor(balansrakning.total_assets, figures.totalAssets)
    const assets = balansrakning.assets
    const claims = balansrakning.equity_liabilities
    expectKronor(amount(assets, 'Inventarier, verktyg och installationer'), figures.tangibleAssets)
    expectKronor(amount(assets, 'Färdiga varor och handelsvaror'), figures.stock)
    expectKronor(amount(assets, 'Kundfordringar'), figures.receivables)
    expectKronor(amount(assets, 'Kassa och bank'), figures.cash)
    expectKronor(amount(claims, 'Aktiekapital'), figures.shareCapital)
    expectKronor(amount(claims, 'Balanserat resultat'), figures.retainedEarnings)
    expectKronor(amount(claims, 'Årets resultat'), figures.result)
    expectKronor(amount(claims, 'Leverantörsskulder'), figures.supplierPayables)
    expectKronor(amount(claims, 'Skatteskulder'), figures.corporateTaxLiability)
    expectKronor(amount(claims, 'Övriga skulder'), figures.vatLiability + figures.payrollLiabilities)
    expectKronor(amount(claims, 'Upplupna kostnader och förutbetalda intäkter'), figures.accruedVacation)
  })

  it('shows the year before as the comparison', async () => {
    const { report } = await preview()
    if (!previous) {
      expect(report.previous_period).toBeNull()
      return
    }
    expectKronor(amount(report.resultatrakning, 'Nettoomsättning', 'previous'), previous.revenue)
    expectKronor(amount(report.resultatrakning, 'Årets resultat', 'previous'), previous.result)
    expectKronor(report.balansrakning.total_assets_previous, previous.totalAssets)
  })

  it('passes the draft check with the questions answered', async () => {
    const check = await doors.call('gnubok_validate_arsredovisning', { fiscal_period_id: state.fiscalPeriods[year] })
    const errors = check.validation.issues.filter((issue: { severity: string }) => issue.severity === 'error')
    expect(errors.map((issue: { code: string }) => issue.code)).toEqual([])
  })
})
