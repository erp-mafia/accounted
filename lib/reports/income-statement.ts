import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { roundOre } from '@/lib/money'
import type { IncomeStatementReport, IncomeStatementSection, TrialBalanceRow } from '@/types'

/**
 * Generate Income Statement (Resultaträkning)
 *
 * Filters to class 3-8 accounts:
 * - Rörelseintäkter (3xxx): Revenue
 * - Rörelsekostnader (4-7xxx): Operating expenses
 * - Finansiella poster (8xxx): Financial items
 * - Årets resultat: Net result
 *
 * Three amount columns, the same ones Resultatrapport prints: `ytd_opening`
 * ("Ingående saldo", fiscal-year activity before the window), `amount`
 * ("Period", the window's own activity) and `ytd_closing` ("Ackumulerat").
 * `amount` keeps its original meaning so every existing consumer reads the
 * same number; the two others are additive.
 */
export async function generateIncomeStatement(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: {
    fromDate?: string
    toDate?: string
    /** SIE dim → code filter ({"6":"P001"}). P&L-safe: see trial-balance.ts. */
    dimensions?: Record<string, string>
  }
): Promise<IncomeStatementReport> {
  // Exclude year-end closing entries: after closing, P&L accounts (3-8) are
  // zeroed by the closing verifikat (8999 → 2099). Including them collapses
  // the resultaträkning to zero. The income statement must reflect the
  // pre-closing activity for the year.
  //
  // The period bounds ride along in the same round trip: the report header
  // needs them for the räkenskapsår line and for the column tooltips.
  const [periodResponse, { rows }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, {
      // Operational convention, unchanged. Moving this to 'exclude-final' is
      // Stage 2 of #1051 and deliberately deferred: see DECISIONS.md:632.
      closingEntry: 'exclude-all-year-end',
      fromDate: options?.fromDate,
      toDate: options?.toDate,
      dimensions: options?.dimensions,
    }),
  ])

  // Non-fatal, as in generateBalanceSheet: a period row that cannot be read
  // costs the header dates, not the report.
  const period = periodResponse.data as { period_start: string; period_end: string } | null
  const fiscalYear = {
    start: period?.period_start ?? '',
    end: period?.period_end ?? '',
  }

  // With a fromDate after period start, the trial balance rolls all earlier
  // activity (P&L accounts included) into the opening columns, so the closing
  // columns hold year-to-date figures, not the requested window. A ranged
  // resultaträkning must therefore sum period movements only: the same
  // convention resultatrapport uses. Without a fromDate the closing columns
  // equal the movements for P&L accounts and behavior is unchanged.
  return buildIncomeStatementFromRows(rows, {
    periodMovements: Boolean(options?.fromDate),
    period: {
      start: options?.fromDate ?? fiscalYear.start,
      end: options?.toDate ?? fiscalYear.end,
    },
    fiscalYear,
  })
}

/**
 * Pure income-statement assembly from trial balance rows. Extracted so
 * callers that already hold pre-computed rows (e.g. the KPI route's
 * single-round-trip aggregate path) can reuse the section/rounding logic
 * without re-fetching journal lines. The rows must come from a trial
 * balance generated with excludeYearEndClosing (see generateIncomeStatement
 * above for why).
 */
export function buildIncomeStatementFromRows(
  rows: TrialBalanceRow[],
  buildOptions?: {
    /**
     * Sum period movements (period_debit/period_credit) instead of closing
     * balances. Required whenever the rows were generated with a fromDate
     * after period start: the roll-forward puts pre-range P&L activity into
     * the opening columns and the closing columns become year-to-date.
     */
    periodMovements?: boolean
    /**
     * Reported window and fiscal-year bounds for the header. Optional: the
     * KPI aggregate path holds rows without ever loading the fiscal period,
     * and an empty string pair is what this builder has always returned.
     */
    period?: { start: string; end: string }
    fiscalYear?: { start: string; end: string }
  }
): IncomeStatementReport {
  const periodMovements = buildOptions?.periodMovements ?? false
  const period = buildOptions?.period ?? { start: '', end: '' }
  const fiscalYear = buildOptions?.fiscalYear ?? { start: '', end: '' }
  // Filter to income/expense accounts (class 3-8)
  const incomeExpenseRows = rows.filter(
    (r) => r.account_class >= 3 && r.account_class <= 8
  )

  // Revenue sections (class 3)
  const revenueSections = buildSections(
    incomeExpenseRows.filter((r) => r.account_class === 3),
    {
      '30': 'Huvudintäkter',
      '31': 'Momsfria intäkter',
      '32': 'Förmåner',
      '33': 'Försäljning tjänster utanför Sverige',
      '34': 'Egna uttag',
      '35': 'Fakturerade kostnader',
      '36': 'Sidointäkter',
      '37': 'Intäktskorrigeringar',
      '38': 'Aktiverat arbete',
      '39': 'Övriga rörelseintäkter',
    },
    'credit', // Revenue has credit normal balance
    'Övriga intäkter',
    periodMovements,
  )

  // Expense sections (class 4-7)
  const expenseSections = buildSections(
    incomeExpenseRows.filter((r) => r.account_class >= 4 && r.account_class <= 7),
    {
      '40': 'Varor och material',
      '41': 'Förändring lager',
      '42': 'Sålda handelsvaror VMB',
      '43': 'Råvaror och material',
      '44': 'Inköp omvänd betalningsskyldighet',
      '45': 'Inköp utlandet',
      '46': 'Underentreprenader och legoarbeten',
      '47': 'Erhållna rabatter',
      '48': 'Andra produktionskostnader',
      '49': 'Lagerförändringar',
      '50': 'Lokalkostnader',
      '51': 'Fastighetskostnader',
      '52': 'Hyra av tillgångar',
      '53': 'Energikostnader',
      '54': 'Förbrukningsinventarier',
      '55': 'Reparation och underhåll',
      '56': 'Transportkostnader',
      '57': 'Frakter och transporter',
      '58': 'Resekostnader',
      '59': 'Reklam och PR',
      '60': 'Övriga försäljningskostnader',
      '61': 'Kontorsmateriel',
      '62': 'Tele och post',
      '63': 'Försäkringar och riskkostnader',
      '64': 'Förvaltningskostnader',
      '65': 'Övriga externa tjänster',
      '67': 'Särskilt för ideella föreningar och stiftelser',
      '68': 'Inhyrd personal',
      '69': 'Övriga kostnader',
      '70': 'Löner kollektivanställda',
      '72': 'Löner tjänstemän/företagsledare',
      '73': 'Kostnadsersättningar och förmåner',
      '74': 'Pensionskostnader',
      '75': 'Sociala avgifter',
      '76': 'Övriga personalkostnader',
      '77': 'Nedskrivningar',
      '78': 'Avskrivningar',
      '79': 'Övriga rörelsekostnader',
    },
    'debit', // Expenses have debit normal balance
    'Övriga kostnader',
    periodMovements,
  )

  // Financial sections (class 8): exclude 8999 "Årets resultat".
  // 8999 is a closing account: when year-end posts "8999 debit → 2099 credit"
  // to move the computed profit into equity, including 8999's debit balance
  // here cancels out the revenue/expense difference and drives net_result to
  // zero. The income statement shows the *computed* årets resultat as
  // (revenue - expenses + financial), so 8999's own balance must stay out.
  const financialSections = buildSections(
    incomeExpenseRows.filter(
      (r) => r.account_class === 8 && r.account_number !== '8999'
    ),
    {
      '80': 'Resultat andelar koncernföretag',
      '81': 'Resultat andelar intresseföretag',
      '82': 'Resultat övriga värdepapper',
      '83': 'Ränteintäkter',
      '84': 'Räntekostnader',
      '88': 'Bokslutsdispositioner',
      '89': 'Skatter och årets resultat',
    },
    'mixed',
    'Övriga finansiella poster',
    periodMovements,
  )

  const totalRevenue = sumSections(revenueSections, (s) => s.subtotal)
  const totalExpenses = sumSections(expenseSections, (s) => s.subtotal)
  const totalFinancial = sumSections(financialSections, (s) => s.subtotal)
  const totalRevenueYtdOpening = sumSections(revenueSections, (s) => s.subtotal_ytd_opening)
  const totalExpensesYtdOpening = sumSections(expenseSections, (s) => s.subtotal_ytd_opening)
  const totalFinancialYtdOpening = sumSections(financialSections, (s) => s.subtotal_ytd_opening)
  const totalRevenueYtdClosing = sumSections(revenueSections, (s) => s.subtotal_ytd_closing)
  const totalExpensesYtdClosing = sumSections(expenseSections, (s) => s.subtotal_ytd_closing)
  const totalFinancialYtdClosing = sumSections(financialSections, (s) => s.subtotal_ytd_closing)

  return {
    revenue_sections: revenueSections.filter((s) => s.rows.length > 0),
    total_revenue: totalRevenue,
    total_revenue_ytd_opening: totalRevenueYtdOpening,
    total_revenue_ytd_closing: totalRevenueYtdClosing,
    expense_sections: expenseSections.filter((s) => s.rows.length > 0),
    total_expenses: totalExpenses,
    total_expenses_ytd_opening: totalExpensesYtdOpening,
    total_expenses_ytd_closing: totalExpensesYtdClosing,
    financial_sections: financialSections.filter((s) => s.rows.length > 0),
    total_financial: totalFinancial,
    total_financial_ytd_opening: totalFinancialYtdOpening,
    total_financial_ytd_closing: totalFinancialYtdClosing,
    net_result: roundOre(totalRevenue - totalExpenses + totalFinancial),
    net_result_ytd_opening: roundOre(
      totalRevenueYtdOpening - totalExpensesYtdOpening + totalFinancialYtdOpening
    ),
    net_result_ytd_closing: roundOre(
      totalRevenueYtdClosing - totalExpensesYtdClosing + totalFinancialYtdClosing
    ),
    period,
    fiscal_year: fiscalYear,
  }
}

function sumSections(
  sections: IncomeStatementSection[],
  pick: (section: IncomeStatementSection) => number
): number {
  return roundOre(sections.reduce((sum, s) => sum + pick(s), 0))
}

/**
 * Build report sections from trial balance rows.
 *
 * Every row is assigned to exactly one section: either a known 2-digit group
 * (from `groupLabels`) or the `fallbackTitle` catch-all for any group not in
 * the map. The catch-all is what keeps the report complete: without it, an
 * account whose group code is missing from `groupLabels` (e.g. 53xx
 * energikostnader, 48xx, 67xx) would be silently dropped from both the
 * breakdown and the computed subtotal/total/net_result.
 */
function buildSections(
  rows: TrialBalanceRow[],
  groupLabels: Record<string, string>,
  normalBalance: 'debit' | 'credit' | 'mixed',
  fallbackTitle: string,
  periodMovements = false
): IncomeStatementSection[] {
  // Expenses (debit) use debit - credit; revenue (credit) and financial
  // (mixed) use credit - debit.
  const signed = (debit: number, credit: number) =>
    normalBalance === 'debit' ? debit - credit : credit - debit

  const makeSection = (title: string, groupRows: TrialBalanceRow[]): IncomeStatementSection => {
    const sectionRows = groupRows.map((r) => {
      // Ranged reports sum the window's movements (period columns);
      // full-period reports keep the closing columns.
      const debit = periodMovements ? r.period_debit : r.closing_debit
      const credit = periodMovements ? r.period_credit : r.closing_credit

      // `opening_*`, not `year_opening_*`: for a P&L account the fiscal-year
      // opening balance is empty by construction (the OB entry carries classes
      // 1-2 only), so everything the trial balance rolled into `opening_*`
      // between period_start and fromDate is exactly this year's pre-window
      // activity. `closingEntry: 'exclude-all-year-end'` keeps a resultatavslut
      // out of both columns. In the full-period case nothing is rolled forward,
      // so ytd_opening reads 0 and ytd_closing equals the period amount.
      return {
        account_number: r.account_number,
        account_name: r.account_name,
        amount: roundOre(signed(debit, credit)),
        ytd_opening: roundOre(signed(r.opening_debit, r.opening_credit)),
        ytd_closing: roundOre(signed(r.closing_debit, r.closing_credit)),
      }
    })

    return {
      title,
      // An account with activity earlier in the year but none in the window
      // still belongs on the report: its Ackumulerat column is non-zero.
      rows: sectionRows.filter(
        (r) => Math.abs(r.amount) > 0.005 || Math.abs(r.ytd_closing) > 0.005
      ),
      subtotal: roundOre(sectionRows.reduce((sum, r) => sum + r.amount, 0)),
      subtotal_ytd_opening: roundOre(
        sectionRows.reduce((sum, r) => sum + r.ytd_opening, 0)
      ),
      subtotal_ytd_closing: roundOre(
        sectionRows.reduce((sum, r) => sum + r.ytd_closing, 0)
      ),
    }
  }

  const sections: IncomeStatementSection[] = []
  const matched = new Set<string>()

  for (const [groupCode, title] of Object.entries(groupLabels)) {
    const groupRows = rows.filter((r) => r.account_number.startsWith(groupCode))
    if (groupRows.length === 0) continue
    for (const r of groupRows) matched.add(r.account_number)
    sections.push(makeSection(title, groupRows))
  }

  // Catch-all: any row whose 2-digit group is not in groupLabels. Guarantees no
  // account is ever excluded from the subtotal/total/net_result.
  const orphans = rows.filter((r) => !matched.has(r.account_number))
  if (orphans.length > 0) sections.push(makeSection(fallbackTitle, orphans))

  return sections
}
