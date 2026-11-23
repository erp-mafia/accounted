import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { buildImbalanceDiagnosis } from './imbalance-diagnosis'
import { roundOre } from '@/lib/money'
import type {
  BalanceImbalanceDiagnosis,
  BalanceSheetReport,
  BalanceSheetSection,
  TrialBalanceRow,
} from '@/types'

const EQUITY_SECTION_TITLE = 'Eget kapital'

/**
 * Generate Balance Sheet (Balansräkning)
 *
 * Filters to class 1-2 accounts:
 * - Tillgångar (1xxx): Assets
 * - Eget kapital och skulder (2xxx): Equity and liabilities
 */
export async function generateBalanceSheet(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: { fromDate?: string; toDate?: string }
): Promise<BalanceSheetReport> {
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    // Balance sheet: 2099 must carry årets resultat, so the resultatavslut stays in.
    closingEntry: 'include',
    fromDate: options?.fromDate,
    toDate: options?.toDate,
  })
  return balanceSheetFromTrialBalance(supabase, companyId, fiscalPeriodId, rows)
}

/**
 * The balance sheet from trial balance rows the caller already holds, so a
 * report that built the period's trial balance does not build it again.
 * The rows must come from generateTrialBalance with closingEntry 'include'
 * over the same period and range: 2099 has to carry årets resultat. The
 * imbalance diagnosis still reads the ledger, and only when the sheet does
 * not balance.
 */
export async function balanceSheetFromTrialBalance(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  rows: TrialBalanceRow[],
): Promise<BalanceSheetReport> {
  // Filter to balance sheet accounts (class 1-2)
  const balanceRows = rows.filter(
    (r) => r.account_class >= 1 && r.account_class <= 2
  )

  // Asset sections (class 1)
  const assetSections = buildBalanceSections(
    balanceRows.filter((r) => r.account_class === 1),
    {
      '10': 'Immateriella anläggningstillgångar',
      '11': 'Byggnader och mark',
      '12': 'Maskiner och inventarier',
      '13': 'Finansiella anläggningstillgångar',
      '14': 'Lager och pågående arbeten',
      '15': 'Kundfordringar',
      '16': 'Övriga kortfristiga fordringar',
      '17': 'Förutbetalda kostnader och upplupna intäkter',
      '18': 'Kortfristiga placeringar',
      '19': 'Kassa och bank',
    },
    'debit' // Assets have debit normal balance
  )

  // Equity and liability sections (class 2)
  const equityLiabilitySections = buildBalanceSections(
    balanceRows.filter((r) => r.account_class === 2),
    {
      '20': EQUITY_SECTION_TITLE,
      '21': 'Obeskattade reserver',
      '22': 'Avsättningar',
      '23': 'Långfristiga skulder',
      '24': 'Kortfristiga skulder',
      '25': 'Skatteskulder',
      '26': 'Moms och punktskatter',
      '27': 'Personalens skatter och avgifter',
      '28': 'Övriga kortfristiga skulder',
      '29': 'Upplupna kostnader och förutbetalda intäkter',
    },
    'credit' // Equity/liabilities have credit normal balance
  )

  // A genuinely untransferred prior-year result still yields a real
  // differens and the imbalance diagnosis below.
  const periodResult = computedResult(rows)

  // The period result is part of eget kapital, as in the årsredovisning: a
  // synthetic row inside the Eget kapital section and its subtotal, so that
  // subtotal is the company's equity. The grand total is unchanged.
  if (Math.abs(periodResult) > 0.005) {
    const resultRow = { account_number: '', account_name: 'Beräknat resultat', amount: periodResult }
    const equity = equityLiabilitySections.find((s) => s.title === EQUITY_SECTION_TITLE)
    if (equity) {
      equity.rows.push(resultRow)
      equity.subtotal = roundOre(equity.subtotal + periodResult)
    } else {
      equityLiabilitySections.unshift({ title: EQUITY_SECTION_TITLE, rows: [resultRow], subtotal: periodResult })
    }
  }

  const totalAssets =
    Math.round(assetSections.reduce((sum, s) => sum + s.subtotal, 0) * 100) / 100
  const totalEquityLiabilities =
    Math.round(equityLiabilitySections.reduce((sum, s) => sum + s.subtotal, 0) * 100) / 100

  // Name a broken balance instead of leaving a bare differens. An earlier
  // year's untransferred result no longer causes one: the derived opening
  // balance carries it (prior_opening_balance_lines).
  const differens = Math.round((totalAssets - totalEquityLiabilities) * 100) / 100
  const imbalanceDiagnosis: BalanceImbalanceDiagnosis | undefined = buildImbalanceDiagnosis(differens) ?? undefined

  return {
    asset_sections: assetSections.filter((s) => s.rows.length > 0),
    total_assets: totalAssets,
    equity_liability_sections: equityLiabilitySections.filter((s) => s.rows.length > 0),
    total_equity_liabilities: totalEquityLiabilities,
    period: { start: '', end: '' },
    ...(imbalanceDiagnosis ? { imbalance_diagnosis: imbalanceDiagnosis } : {}),
  }
}

/**
 * Årets resultat as the balance side reads it before bokslut: the closing
 * balance of every trial balance row OUTSIDE the balance-sheet classes (1-2),
 * credit-positive, not just class 3-8. Invariant: the result = everything
 * outside the balance-sheet classes, so a resultatavslut that was posted to
 * 2099 but whose counter-line landed on a class 0/9 or class-less account
 * self-cancels here instead of double-counting the result (2099 already
 * carries it among the class 2 rows). The negated range is deliberate: it
 * keeps null/undefined account_class rows in the result. Balansräkning and
 * Balansrapport both read it here, so the two cannot show different results.
 */
export function computedResult(rows: readonly TrialBalanceRow[]): number {
  return roundOre(
    rows
      .filter((r) => !(r.account_class >= 1 && r.account_class <= 2))
      .reduce((sum, r) => sum + (r.closing_credit - r.closing_debit), 0),
  )
}

function buildBalanceSections(
  rows: TrialBalanceRow[],
  groupLabels: Record<string, string>,
  normalBalance: 'debit' | 'credit'
): BalanceSheetSection[] {
  const sections: BalanceSheetSection[] = []

  for (const [groupCode, title] of Object.entries(groupLabels)) {
    const groupRows = rows.filter((r) => r.account_number.startsWith(groupCode))
    if (groupRows.length === 0) continue

    const sectionRows = groupRows.map((r) => {
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

    sections.push({
      title,
      rows: sectionRows.filter((r) => Math.abs(r.amount) > 0.005),
      subtotal: Math.round(subtotal * 100) / 100,
    })
  }

  return sections
}
