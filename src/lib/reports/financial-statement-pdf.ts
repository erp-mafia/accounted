/**
 * Shared model builders for the financial-statement PDFs (resultaträkning /
 * balansräkning). Extracted from the dashboard PDF routes so the v1 REST PDF
 * endpoints render byte-equivalent documents: one place owns the K2/K3
 * grouping and the balance check, two thin routes own auth + transport.
 */

import type {
  FinancialStatementColumn,
  FinancialStatementGroup,
  FinancialStatementSection,
  FinancialStatementSummaryRow,
} from './financial-statement-pdf-template'
import { roundOre } from '@/lib/money'
import type {
  BalanceSheetReport,
  BalanceSheetSection,
  IncomeStatementReport,
  IncomeStatementSection,
} from '@/types'

/**
 * Amount columns, in render order. Abbreviated the way the operational
 * template abbreviates them: the header cell is 82pt at 9pt bold, which
 * "Ingående balans" spelled out does not fit.
 */
export const INCOME_STATEMENT_PDF_COLUMNS: FinancialStatementColumn[] = [
  { label: 'Ing. saldo', muted: true },
  { label: 'Period' },
  { label: 'Ackumulerat', muted: true },
]

export const BALANCE_SHEET_PDF_COLUMNS: FinancialStatementColumn[] = [
  { label: 'Ing. balans', muted: true },
  { label: 'Ing. saldo', muted: true },
  { label: 'Period', muted: true },
  { label: 'Utg. balans' },
]

/** Ingående saldo, Period, Ackumulerat: one figure per column. */
function incomeStatementSection(section: IncomeStatementSection): FinancialStatementSection {
  return {
    title: section.title,
    rows: section.rows.map((r) => ({
      account_number: r.account_number,
      account_name: r.account_name,
      amounts: [r.ytd_opening, r.amount, r.ytd_closing],
    })),
    subtotals: [section.subtotal_ytd_opening, section.subtotal, section.subtotal_ytd_closing],
  }
}

/** Ingående balans, Ingående saldo, Period, Utgående balans. */
function balanceSheetSection(section: BalanceSheetSection): FinancialStatementSection {
  return {
    title: section.title,
    rows: section.rows.map((r) => ({
      account_number: r.account_number,
      account_name: r.account_name,
      amounts: [r.year_ib, r.ib, r.period_change, r.amount],
    })),
    subtotals: [
      section.subtotal_year_ib,
      section.subtotal_ib,
      section.subtotal_period_change,
      section.subtotal,
    ],
  }
}

/** Column-wise sum of a set of section subtotals. */
function sumColumns(sections: FinancialStatementSection[], columnCount: number): number[] {
  return Array.from({ length: columnCount }, (_, ci) =>
    roundOre(sections.reduce((sum, s) => sum + (s.subtotals[ci] ?? 0), 0)),
  )
}

/** Column-wise arithmetic over equally long figure lists. */
function combineColumns(
  columnCount: number,
  combine: (index: number) => number,
): number[] {
  return Array.from({ length: columnCount }, (_, ci) => roundOre(combine(ci)))
}

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
  columns: FinancialStatementColumn[]
  groups: FinancialStatementGroup[]
  summary: FinancialStatementSummaryRow[]
}

/**
 * Build the K2/K3 uppställningsform groups + summary for the resultaträkning
 * PDF from a generated income statement.
 */
export function buildIncomeStatementPdfModel(report: IncomeStatementReport): IncomeStatementPdfModel {
  const columnCount = INCOME_STATEMENT_PDF_COLUMNS.length

  const revenueSections = report.revenue_sections.map(incomeStatementSection)
  const expenseSections = report.expense_sections.map(incomeStatementSection)
  const financialSections = report.financial_sections.map(incomeStatementSection)

  const totalRevenue = [
    report.total_revenue_ytd_opening,
    report.total_revenue,
    report.total_revenue_ytd_closing,
  ]
  const totalExpenses = [
    report.total_expenses_ytd_opening,
    report.total_expenses,
    report.total_expenses_ytd_closing,
  ]
  const operatingResult = combineColumns(
    columnCount,
    (ci) => totalRevenue[ci] - totalExpenses[ci],
  )

  // Split class 8 into its three K2/K3 blocks plus a catch-all for any
  // prefix the generator emits but we haven't explicitly mapped. If a future
  // generator change adds sections for 85/86/87 or similar, this keeps them
  // visible and arithmetically accounted for rather than silently dropped.
  const finansiellaPosterSections = financialSections.filter((s) =>
    sectionPrefix(s, FINANSIELLA_POSTER_PREFIXES),
  )
  const bokslutsdispositionerSections = financialSections.filter((s) =>
    sectionPrefix(s, BOKSLUTSDISPOSITIONER_PREFIXES),
  )
  const skattSections = financialSections.filter((s) =>
    sectionPrefix(s, SKATT_PREFIXES),
  )
  const ovrigaFinansiellaPosterSections = financialSections.filter(
    (s) => !sectionPrefix(s, KNOWN_CLASS_8_PREFIXES),
  )

  const totalFinansiellaPoster = sumColumns(finansiellaPosterSections, columnCount)
  const totalBokslutsdispositioner = sumColumns(bokslutsdispositionerSections, columnCount)
  const totalSkatt = sumColumns(skattSections, columnCount)
  const totalOvrigaFinansiellaPoster = sumColumns(ovrigaFinansiellaPosterSections, columnCount)
  // Catch-all is treated as part of "finansiella poster" for the subtotal:
  // 85-87 accounts in BAS are financial-adjacent (not tax, not bokslut).
  const resultatEfterFinansiellaPoster = combineColumns(
    columnCount,
    (ci) =>
      operatingResult[ci] + totalFinansiellaPoster[ci] + totalOvrigaFinansiellaPoster[ci],
  )

  const groups: FinancialStatementGroup[] = [
    {
      heading: 'Rörelseintäkter',
      sections: revenueSections,
      totalLabel: 'Summa rörelseintäkter',
      totals: totalRevenue,
    },
    {
      heading: 'Rörelsekostnader',
      sections: expenseSections,
      totalLabel: 'Summa rörelsekostnader',
      totals: totalExpenses,
      negate: true,
    },
  ]

  if (finansiellaPosterSections.length > 0) {
    groups.push({
      heading: 'Finansiella poster',
      sections: finansiellaPosterSections,
      totalLabel: 'Summa finansiella poster',
      totals: totalFinansiellaPoster,
    })
  }
  if (ovrigaFinansiellaPosterSections.length > 0) {
    groups.push({
      heading: 'Övriga finansiella poster',
      sections: ovrigaFinansiellaPosterSections,
      totalLabel: 'Summa övriga finansiella poster',
      totals: totalOvrigaFinansiellaPoster,
    })
  }
  if (bokslutsdispositionerSections.length > 0) {
    groups.push({
      heading: 'Bokslutsdispositioner',
      sections: bokslutsdispositionerSections,
      totalLabel: 'Summa bokslutsdispositioner',
      totals: totalBokslutsdispositioner,
    })
  }
  if (skattSections.length > 0) {
    groups.push({
      heading: 'Skatter',
      sections: skattSections,
      totalLabel: 'Summa skatter',
      totals: totalSkatt,
    })
  }

  // K2/K3 uppställningsform (ÅRL bilaga 2) summary structure:
  //   Rörelseresultat
  //   Resultat efter finansiella poster (only if finansiella poster present)
  //   Bokslutsdispositioner (only if present)
  //   Skatt på årets resultat (always, so the reader can verify the tax calc)
  //   Årets resultat
  const summary: FinancialStatementSummaryRow[] = [
    { label: 'Rörelseresultat', amounts: operatingResult },
  ]
  if (
    finansiellaPosterSections.length > 0 ||
    ovrigaFinansiellaPosterSections.length > 0
  ) {
    summary.push({
      label: 'Resultat efter finansiella poster',
      amounts: resultatEfterFinansiellaPoster,
    })
  }
  if (bokslutsdispositionerSections.length > 0) {
    summary.push({ label: 'Bokslutsdispositioner', amounts: totalBokslutsdispositioner })
  }
  summary.push({ label: 'Skatt på årets resultat', amounts: totalSkatt })
  summary.push({
    label: 'Årets resultat',
    amounts: [
      report.net_result_ytd_opening,
      report.net_result,
      report.net_result_ytd_closing,
    ],
    emphasis: true,
  })

  return { columns: INCOME_STATEMENT_PDF_COLUMNS, groups, summary }
}

export interface BalanceSheetPdfModel {
  columns: FinancialStatementColumn[]
  groups: FinancialStatementGroup[]
}

/** Build the balansräkning PDF groups from a generated balance sheet. */
export function buildBalanceSheetPdfModel(report: BalanceSheetReport): BalanceSheetPdfModel {
  return {
    columns: BALANCE_SHEET_PDF_COLUMNS,
    groups: [
      {
        heading: 'Tillgångar',
        sections: report.asset_sections.map(balanceSheetSection),
        totalLabel: 'Summa tillgångar',
        totals: [
          report.total_assets_year_ib,
          report.total_assets_ib,
          report.total_assets_period_change,
          report.total_assets,
        ],
      },
      {
        heading: 'Eget kapital och skulder',
        sections: report.equity_liability_sections.map(balanceSheetSection),
        totalLabel: 'Summa eget kapital och skulder',
        totals: [
          report.total_equity_liabilities_year_ib,
          report.total_equity_liabilities_ib,
          report.total_equity_liabilities_period_change,
          report.total_equity_liabilities,
        ],
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
