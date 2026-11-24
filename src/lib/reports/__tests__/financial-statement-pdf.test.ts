import { describe, it, expect } from 'vitest'
import { buildIncomeStatementPdfModel } from '../financial-statement-pdf'
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
})
