/**
 * Shared model builders for the financial-statement PDFs (resultaträkning /
 * balansräkning). Extracted from the dashboard PDF routes so the v1 REST PDF
 * endpoints render byte-equivalent documents: one place owns the K2/K3
 * grouping and the balance check, two thin routes own auth + transport.
 */

import type {
  FinancialStatementGroup,
  FinancialStatementSection,
  FinancialStatementSummaryRow,
} from './financial-statement-pdf-template'
import type { BalanceSheetReport, IncomeStatementReport } from '@/types'

// K2/K3 uppställningsform (ÅRL bilaga 2, kostnadsslagsindelad) splits class 8
// into three named blocks with subtotals:
//   80-84 → Finansiella poster (followed by "Resultat efter finansiella poster")
//   88   → Bokslutsdispositioner
//   89   → Skatt på årets resultat
// The generator lumps these together under financial_sections, so we split
// here by the first row's account prefix.
const FINANSIELLA_POSTER_PREFIXES = ['80', '81', '82', '83', '84']
const BOKSLUTSDISPOSITIONER_PREFIXES = ['88']
const SKATT_PREFIXES = ['89']
const KNOWN_CLASS_8_PREFIXES = [
  ...FINANSIELLA_POSTER_PREFIXES,
  ...BOKSLUTSDISPOSITIONER_PREFIXES,
  ...SKATT_PREFIXES,
]

function sectionPrefix(section: FinancialStatementSection, prefixes: string[]): boolean {
  if (section.rows.length === 0) return false
  const acc = section.rows[0].account_number
  return prefixes.some((p) => acc.startsWith(p))
}

export interface IncomeStatementPdfModel {
  groups: FinancialStatementGroup[]
  summary: FinancialStatementSummaryRow[]
}

/**
 * Build the K2/K3 uppställningsform groups + summary for the resultaträkning
 * PDF from a generated income statement.
 */
export function buildIncomeStatementPdfModel(report: IncomeStatementReport): IncomeStatementPdfModel {
  const operatingResult = Math.round((report.total_revenue - report.total_expenses) * 100) / 100

  // Split class 8 into its three K2/K3 blocks plus a catch-all for any
  // prefix the generator emits but we haven't explicitly mapped. If a future
  // generator change adds sections for 85/86/87 or similar, this keeps them
  // visible and arithmetically accounted for rather than silently dropped.
  const finansiellaPosterSections = report.financial_sections.filter((s) =>
    sectionPrefix(s, FINANSIELLA_POSTER_PREFIXES),
  )
  const bokslutsdispositionerSections = report.financial_sections.filter((s) =>
    sectionPrefix(s, BOKSLUTSDISPOSITIONER_PREFIXES),
  )
  const skattSections = report.financial_sections.filter((s) =>
    sectionPrefix(s, SKATT_PREFIXES),
  )
  const ovrigaFinansiellaPosterSections = report.financial_sections.filter(
    (s) => !sectionPrefix(s, KNOWN_CLASS_8_PREFIXES),
  )

  const totalFinansiellaPoster = Math.round(
    finansiellaPosterSections.reduce((sum, s) => sum + s.subtotal, 0) * 100,
  ) / 100
  const totalBokslutsdispositioner = Math.round(
    bokslutsdispositionerSections.reduce((sum, s) => sum + s.subtotal, 0) * 100,
  ) / 100
  const totalSkatt = Math.round(
    skattSections.reduce((sum, s) => sum + s.subtotal, 0) * 100,
  ) / 100
  const totalOvrigaFinansiellaPoster = Math.round(
    ovrigaFinansiellaPosterSections.reduce((sum, s) => sum + s.subtotal, 0) * 100,
  ) / 100
  // Catch-all is treated as part of "finansiella poster" for the subtotal:
  // 85-87 accounts in BAS are financial-adjacent (not tax, not bokslut).
  const resultatEfterFinansiellaPoster = Math.round(
    (operatingResult + totalFinansiellaPoster + totalOvrigaFinansiellaPoster) * 100,
  ) / 100

  const groups: FinancialStatementGroup[] = [
    {
      heading: 'Rörelseintäkter',
      sections: report.revenue_sections,
      totalLabel: 'Summa rörelseintäkter',
      total: report.total_revenue,
    },
    {
      heading: 'Rörelsekostnader',
      sections: report.expense_sections,
      totalLabel: 'Summa rörelsekostnader',
      total: report.total_expenses,
      negate: true,
    },
  ]

  if (finansiellaPosterSections.length > 0) {
    groups.push({
      heading: 'Finansiella poster',
      sections: finansiellaPosterSections,
      totalLabel: 'Summa finansiella poster',
      total: totalFinansiellaPoster,
    })
  }
  if (ovrigaFinansiellaPosterSections.length > 0) {
    groups.push({
      heading: 'Övriga finansiella poster',
      sections: ovrigaFinansiellaPosterSections,
      totalLabel: 'Summa övriga finansiella poster',
      total: totalOvrigaFinansiellaPoster,
    })
  }
  if (bokslutsdispositionerSections.length > 0) {
    groups.push({
      heading: 'Bokslutsdispositioner',
      sections: bokslutsdispositionerSections,
      totalLabel: 'Summa bokslutsdispositioner',
      total: totalBokslutsdispositioner,
    })
  }
  if (skattSections.length > 0) {
    groups.push({
      heading: 'Skatter',
      sections: skattSections,
      totalLabel: 'Summa skatter',
      total: totalSkatt,
    })
  }

  // K2/K3 uppställningsform (ÅRL bilaga 2) summary structure:
  //   Rörelseresultat
  //   Resultat efter finansiella poster (only if finansiella poster present)
  //   Bokslutsdispositioner (only if present)
  //   Skatt på årets resultat (always, so the reader can verify the tax calc)
  //   Årets resultat
  const summary: FinancialStatementSummaryRow[] = [
    { label: 'Rörelseresultat', amount: operatingResult },
  ]
  if (
    finansiellaPosterSections.length > 0 ||
    ovrigaFinansiellaPosterSections.length > 0
  ) {
    summary.push({
      label: 'Resultat efter finansiella poster',
      amount: resultatEfterFinansiellaPoster,
    })
  }
  if (bokslutsdispositionerSections.length > 0) {
    summary.push({ label: 'Bokslutsdispositioner', amount: totalBokslutsdispositioner })
  }
  summary.push({ label: 'Skatt på årets resultat', amount: totalSkatt })
  summary.push({ label: 'Årets resultat', amount: report.net_result, emphasis: true })

  return { groups, summary }
}

export interface BalanceSheetPdfModel {
  groups: FinancialStatementGroup[]
}

/** Build the balansräkning PDF groups from a generated balance sheet. */
export function buildBalanceSheetPdfModel(report: BalanceSheetReport): BalanceSheetPdfModel {
  return {
    groups: [
      {
        heading: 'Tillgångar',
        sections: report.asset_sections,
        totalLabel: 'Summa tillgångar',
        total: report.total_assets,
      },
      {
        heading: 'Eget kapital och skulder',
        sections: report.equity_liability_sections,
        totalLabel: 'Summa eget kapital och skulder',
        total: report.total_equity_liabilities,
      },
    ],
  }
}

/**
 * ÅRL 3 kap / K2 / K3 require balansräkningen to balance. Compare rounded
 * to whole kronor: matches SFL 22:1's truncation convention for statutory
 * reports and is immune to floating-point accumulation across hundreds of
 * ledger lines (öresavrundning noise under half a krona is never a real
 * accounting error). The on-screen view still surfaces a "Balanserar ej"
 * warning at öre precision so users can diagnose smaller discrepancies.
 */
export function balanceSheetImbalanceKronor(report: BalanceSheetReport): number {
  return Math.abs(Math.round(report.total_assets) - Math.round(report.total_equity_liabilities))
}
