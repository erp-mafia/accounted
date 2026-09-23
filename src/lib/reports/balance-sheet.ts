import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { findUntransferredResults, buildImbalanceDiagnosis } from './imbalance-diagnosis'
import type {
  BalanceImbalanceDiagnosis,
  BalanceSheetReport,
  BalanceSheetSection,
  TrialBalanceRow,
} from '@/types'

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
      '20': 'Eget kapital',
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

  // Calculate the period result from every row OUTSIDE the balance-sheet
  // classes (1-2), not just class 3-8. Invariant: synthetic result =
  // everything outside the balance-sheet classes, so a resultatavslut that
  // was posted to 2099 but whose counter-line landed on a class 0/9 or
  // class-less account self-cancels here instead of double-counting the
  // result (2099 already carries it inside the class 2 sections). The
  // negated range is deliberate: it keeps null/undefined account_class rows
  // in the result. A genuinely untransferred prior-year result still yields
  // a real differens and the imbalance diagnosis below.
  const incomeExpenseRows = rows.filter(
    (r) => !(r.account_class >= 1 && r.account_class <= 2)
  )
  const periodResult = Math.round(
    incomeExpenseRows.reduce(
      (sum, r) => sum + (r.closing_credit - r.closing_debit),
      0
    ) * 100
  ) / 100

  // Add period result as a synthetic section under equity if non-zero
  if (Math.abs(periodResult) > 0.005) {
    equityLiabilitySections.push({
      title: 'Årets resultat',
      rows: [
        {
          account_number: '',
          account_name: 'Beräknat resultat',
          amount: periodResult,
        },
      ],
      subtotal: periodResult,
    })
  }

  const totalAssets =
    Math.round(assetSections.reduce((sum, s) => sum + s.subtotal, 0) * 100) / 100
  const totalEquityLiabilities =
    Math.round(equityLiabilitySections.reduce((sum, s) => sum + s.subtotal, 0) * 100) / 100

  // Explain a broken balance instead of leaving a bare differens. The usual
  // cause after multi-year migrations is a prior year whose result was never
  // transferred to equity (see imbalance-diagnosis.ts). Only runs on the
  // unbalanced path and must never break the report itself.
  let imbalanceDiagnosis: BalanceImbalanceDiagnosis | undefined
  const differens = Math.round((totalAssets - totalEquityLiabilities) * 100) / 100
  if (Math.abs(differens) >= 0.01) {
    try {
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('period_start')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      const untransferred = await findUntransferredResults(supabase, companyId, {
        beforePeriodStart: period?.period_start,
      })
      imbalanceDiagnosis = buildImbalanceDiagnosis(untransferred, differens) ?? undefined
    } catch {
      // Best-effort diagnosis only — the report still renders without it.
    }
  }

  return {
    asset_sections: assetSections.filter((s) => s.rows.length > 0),
    total_assets: totalAssets,
    equity_liability_sections: equityLiabilitySections.filter((s) => s.rows.length > 0),
    total_equity_liabilities: totalEquityLiabilities,
    period: { start: '', end: '' },
    ...(imbalanceDiagnosis ? { imbalance_diagnosis: imbalanceDiagnosis } : {}),
  }
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
