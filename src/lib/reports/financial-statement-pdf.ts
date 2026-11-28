/**
 * Shared model builders for the financial-statement PDFs (resultaträkning /
 * balansräkning). Extracted from the dashboard PDF routes so the v1 REST PDF
 * endpoints render byte-equivalent documents: one place owns the K2/K3
 * grouping and the balance check, two thin routes own auth + transport. The
 * resultaträkning's page and Excel read the same layout (incomeStatementLayout).
 * Pure, safe in the browser.
 */

import type {
  FinancialStatementGroup,
  FinancialStatementSummaryRow,
} from './financial-statement-pdf-template'
import type { BalanceSheetReport, IncomeStatementReport, IncomeStatementSection } from '@/types'
import { roundOre } from '@/lib/money'
import { NET_RESULT_LABEL } from './income-definitions'
import { RESULT_AFTER_FINANCIAL_LABEL, splitClass8, type Class8Group } from './class-8-groups'

/** One class-8 block of the resultaträkning (class-8-groups.ts) with its sections and sum. */
export interface IncomeStatementClass8Block {
  group: Class8Group
  sections: IncomeStatementSection[]
  total: number
}

/**
 * The resultaträkning's layout below the rörelsekostnader, read by its page,
 * PDF and Excel: Rörelseresultat, class 8 in its uppställningsform blocks, and
 * Resultat efter finansiella poster after the blocks above that line (null
 * when class 8 has none: the line would repeat Rörelseresultat).
 */
export interface IncomeStatementLayout {
  operatingResult: number
  class8: IncomeStatementClass8Block[]
  resultAfterFinancial: number | null
}

export function incomeStatementLayout(report: IncomeStatementReport): IncomeStatementLayout {
  const operatingResult = roundOre(report.total_revenue - report.total_expenses)
  // A section is one kontogrupp (or the generator's catch-all for the groups
  // it has no name for), so its first row places all of it.
  const class8 = splitClass8(report.financial_sections, (s) => s.rows[0]?.account_number ?? '').map(
    ({ group, items }) => ({
      group,
      sections: items,
      total: roundOre(items.reduce((sum, s) => sum + s.subtotal, 0)),
    }),
  )
  const above = class8.filter((block) => block.group.aboveResultAfterFinancial)
  return {
    operatingResult,
    class8,
    resultAfterFinancial:
      above.length > 0 ? roundOre(above.reduce((sum, block) => sum + block.total, operatingResult)) : null,
  }
}

export interface IncomeStatementPdfModel {
  groups: FinancialStatementGroup[]
  summary: FinancialStatementSummaryRow[]
}

/**
 * Build the K2/K3 uppställningsform groups + summary for the resultaträkning
 * PDF from a generated income statement. The Excel's Sammanfattning reads the
 * same summary.
 */
export function buildIncomeStatementPdfModel(report: IncomeStatementReport): IncomeStatementPdfModel {
  const layout = incomeStatementLayout(report)

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
    ...layout.class8.map((block) => ({
      heading: block.group.heading,
      sections: block.sections,
      totalLabel: block.group.totalLabel,
      total: block.total,
    })),
  ]

  // Summary, in ÅRL bilaga 2 order:
  //   Rörelseresultat
  //   Resultat efter finansiella poster (only if finansiella poster present)
  //   Bokslutsdispositioner (only if present)
  //   Skatt på årets resultat (only if present)
  //   Resultat före bokslutstransaktioner
  // The report leaves out every source_type 'year_end' entry, so 88xx and
  // 89xx appear only when booked outside the year-end close (a manual or
  // imported verifikat), and the bottom line is not the årsredovisning's
  // Årets resultat.
  const summary: FinancialStatementSummaryRow[] = [
    { label: 'Rörelseresultat', amount: layout.operatingResult },
  ]
  if (layout.resultAfterFinancial !== null) {
    summary.push({ label: RESULT_AFTER_FINANCIAL_LABEL, amount: layout.resultAfterFinancial })
  }
  for (const block of layout.class8) {
    if (block.group.key === 'bokslutsdispositioner') {
      summary.push({ label: 'Bokslutsdispositioner', amount: block.total })
    } else if (block.group.key === 'skatter') {
      summary.push({ label: 'Skatt på årets resultat', amount: block.total })
    }
  }
  summary.push({ label: NET_RESULT_LABEL, amount: report.net_result, emphasis: true })

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
