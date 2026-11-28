import { describe, it, expect } from 'vitest'
import { buildIncomeStatementPdfModel, incomeStatementLayout } from '../financial-statement-pdf'
import { NET_RESULT_LABEL } from '../income-definitions'
import type { IncomeStatementReport, IncomeStatementSection } from '@/types'

function section(title: string, account: string, amount: number): IncomeStatementSection {
  return { title, rows: [{ account_number: account, account_name: title, amount }], subtotal: amount }
}

function report(financial: IncomeStatementSection[], netResult: number): IncomeStatementReport {
  return {
    revenue_sections: [section('Huvudintäkter', '3001', 500_000)],
    total_revenue: 500_000,
    expense_sections: [section('Lokalkostnader', '5010', 120_000)],
    total_expenses: 120_000,
    financial_sections: financial,
    total_financial: financial.reduce((sum, s) => sum + s.subtotal, 0),
    net_result: netResult,
    period: { start: '2026-01-01', end: '2026-12-31' },
  }
}

describe('buildIncomeStatementPdfModel', () => {
  it('names the bottom line Resultat före bokslutstransaktioner, never Årets resultat', () => {
    const { summary } = buildIncomeStatementPdfModel(report([section('Räntekostnader', '8410', -2_000)], 378_000))

    expect(NET_RESULT_LABEL).toBe('Resultat före bokslutstransaktioner')
    expect(summary.at(-1)).toEqual({ label: NET_RESULT_LABEL, amount: 378_000, emphasis: true })
    expect(summary.map((row) => row.label)).not.toContain('Årets resultat')
  })

  it('prints no tax or bokslutsdispositioner line when no 88xx or 89xx is booked', () => {
    const { summary } = buildIncomeStatementPdfModel(report([section('Räntekostnader', '8410', -2_000)], 378_000))

    expect(summary.map((row) => row.label)).toEqual([
      'Rörelseresultat',
      'Resultat efter finansiella poster',
      NET_RESULT_LABEL,
    ])
  })

  it('still shows 88xx and 89xx booked by a verifikat outside the year-end close', () => {
    const { summary } = buildIncomeStatementPdfModel(
      report(
        [section('Bokslutsdispositioner', '8811', -50_000), section('Skatter och årets resultat', '8910', -68_000)],
        262_000,
      ),
    )

    expect(summary).toEqual([
      { label: 'Rörelseresultat', amount: 380_000 },
      { label: 'Bokslutsdispositioner', amount: -50_000 },
      { label: 'Skatt på årets resultat', amount: -68_000 },
      { label: NET_RESULT_LABEL, amount: 262_000, emphasis: true },
    ])
  })

  it('groups class 8 as the uppställningsform does: finansiella poster, bokslutsdispositioner, skatter', () => {
    const { groups, summary } = buildIncomeStatementPdfModel(
      report(
        [
          section('Ränteintäkter', '8314', 1_000),
          section('Räntekostnader', '8410', -3_000),
          section('Bokslutsdispositioner', '8811', -50_000),
          section('Skatter och årets resultat', '8910', -68_000),
        ],
        260_000,
      ),
    )

    expect(groups.map((g) => [g.heading, g.totalLabel, g.total])).toEqual([
      ['Rörelseintäkter', 'Summa rörelseintäkter', 500_000],
      ['Rörelsekostnader', 'Summa rörelsekostnader', 120_000],
      ['Finansiella poster', 'Summa finansiella poster', -2_000],
      ['Bokslutsdispositioner', 'Summa bokslutsdispositioner', -50_000],
      ['Skatter', 'Summa skatter', -68_000],
    ])
    expect(summary).toEqual([
      { label: 'Rörelseresultat', amount: 380_000 },
      { label: 'Resultat efter finansiella poster', amount: 378_000 },
      { label: 'Bokslutsdispositioner', amount: -50_000 },
      { label: 'Skatt på årets resultat', amount: -68_000 },
      { label: NET_RESULT_LABEL, amount: 260_000, emphasis: true },
    ])
  })
})

describe('incomeStatementLayout', () => {
  it('places Resultat efter finansiella poster after the blocks above it, other class-8 groups included', () => {
    const layout = incomeStatementLayout(
      report(
        [
          section('Räntekostnader', '8410', -3_000),
          section('Övriga finansiella poster', '8510', 500),
          section('Bokslutsdispositioner', '8811', -50_000),
        ],
        327_500,
      ),
    )

    expect(layout.operatingResult).toBe(380_000)
    expect(layout.class8.map((b) => [b.group.key, b.total])).toEqual([
      ['finansiella_poster', -3_000],
      ['ovriga_finansiella_poster', 500],
      ['bokslutsdispositioner', -50_000],
    ])
    expect(layout.resultAfterFinancial).toBe(377_500)
  })

  it('has no Resultat efter finansiella poster when class 8 holds only bokslutsdispositioner and skatt', () => {
    const layout = incomeStatementLayout(report([section('Skatter och årets resultat', '8910', -68_000)], 312_000))

    expect(layout.class8.map((b) => b.group.key)).toEqual(['skatter'])
    expect(layout.resultAfterFinancial).toBeNull()
  })
})
