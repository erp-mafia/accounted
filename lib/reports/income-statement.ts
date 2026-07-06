import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import type { IncomeStatementReport, IncomeStatementSection, TrialBalanceRow } from '@/types'

/**
 * Generate Income Statement (Resultaträkning)
 *
 * Filters to class 3-8 accounts:
 * - Rörelseintäkter (3xxx): Revenue
 * - Rörelsekostnader (4-7xxx): Operating expenses
 * - Finansiella poster (8xxx): Financial items
 * - Årets resultat: Net result
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
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    excludeYearEndClosing: true,
    fromDate: options?.fromDate,
    toDate: options?.toDate,
    dimensions: options?.dimensions,
  })

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
  )

  const totalRevenue = revenueSections.reduce((sum, s) => sum + s.subtotal, 0)
  const totalExpenses = expenseSections.reduce((sum, s) => sum + s.subtotal, 0)
  const totalFinancial = financialSections.reduce((sum, s) => sum + s.subtotal, 0)

  return {
    revenue_sections: revenueSections.filter((s) => s.rows.length > 0),
    total_revenue: Math.round(totalRevenue * 100) / 100,
    expense_sections: expenseSections.filter((s) => s.rows.length > 0),
    total_expenses: Math.round(totalExpenses * 100) / 100,
    financial_sections: financialSections.filter((s) => s.rows.length > 0),
    total_financial: Math.round(totalFinancial * 100) / 100,
    net_result: Math.round((totalRevenue - totalExpenses + totalFinancial) * 100) / 100,
    period: { start: '', end: '' }, // Will be filled by caller
  }
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
  fallbackTitle: string
): IncomeStatementSection[] {
  const makeSection = (title: string, groupRows: TrialBalanceRow[]): IncomeStatementSection => {
    const sectionRows = groupRows.map((r) => {
      // Expenses (debit) use debit - credit; revenue (credit) and financial
      // (mixed) use credit - debit.
      const amount =
        normalBalance === 'debit'
          ? r.closing_debit - r.closing_credit
          : r.closing_credit - r.closing_debit

      return {
        account_number: r.account_number,
        account_name: r.account_name,
        amount: Math.round(amount * 100) / 100,
      }
    })

    const subtotal = sectionRows.reduce((sum, r) => sum + r.amount, 0)

    return {
      title,
      rows: sectionRows.filter((r) => Math.abs(r.amount) > 0.005),
      subtotal: Math.round(subtotal * 100) / 100,
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
