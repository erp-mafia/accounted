import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { findUntransferredResults, buildImbalanceDiagnosis } from './imbalance-diagnosis'
import { roundOre } from '@/lib/money'
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
 *
 * Four amount columns, the same ones Balansrapport prints and in the same
 * order: `year_ib` ("Ingående balans", the balance at fiscal-year start),
 * `ib` ("Ingående saldo", the balance at the start of the reported window),
 * `period_change`, and `amount` (the closing balance). `amount` keeps its
 * original meaning so every existing consumer reads the same number; the
 * three others are additive. All four carry the section's normal-balance
 * sign: assets positive, equity and liabilities positive.
 */
export async function generateBalanceSheet(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: { fromDate?: string; toDate?: string }
): Promise<BalanceSheetReport> {
  // The period bounds are needed for the fiscal_year header and (on the
  // unbalanced path) for the diagnosis. Read once, in parallel with the trial
  // balance, rather than the second read the diagnosis path used to make.
  const [periodResponse, { rows }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, {
      // Balance sheet: 2099 must carry årets resultat, so the resultatavslut stays in.
      closingEntry: 'include',
      fromDate: options?.fromDate,
      toDate: options?.toDate,
    }),
  ])

  // Deliberately non-fatal, unlike Balansrapport: this generator has never
  // thrown on a missing period row, and the v1 API, the MCP tools and the
  // bokslut builders all call it. A period that cannot be read costs the
  // header dates, not the report.
  const period = periodResponse.data as { period_start: string; period_end: string } | null
  const fiscalYearStart = period?.period_start ?? ''
  const fiscalYearEnd = period?.period_end ?? ''

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
  //
  // One figure per column, from the matching trial-balance columns, so the
  // equity side still sums in every column and not just in Utgående balans.
  const incomeExpenseRows = rows.filter(
    (r) => !(r.account_class >= 1 && r.account_class <= 2)
  )
  const periodResult = sumCreditPositive(
    incomeExpenseRows,
    (r) => r.closing_credit - r.closing_debit
  )
  const periodResultYearIb = sumCreditPositive(
    incomeExpenseRows,
    (r) => r.year_opening_credit - r.year_opening_debit
  )
  const periodResultIb = sumCreditPositive(
    incomeExpenseRows,
    (r) => r.opening_credit - r.opening_debit
  )

  // Add period result as a synthetic section under equity if non-zero
  if (Math.abs(periodResult) > 0.005) {
    equityLiabilitySections.push({
      title: 'Årets resultat',
      rows: [
        {
          account_number: '',
          account_name: 'Beräknat resultat',
          amount: periodResult,
          year_ib: periodResultYearIb,
          ib: periodResultIb,
          period_change: roundOre(periodResult - periodResultIb),
        },
      ],
      subtotal: periodResult,
      subtotal_year_ib: periodResultYearIb,
      subtotal_ib: periodResultIb,
      subtotal_period_change: roundOre(periodResult - periodResultIb),
    })
  }

  const totalAssets = sumSections(assetSections, (s) => s.subtotal)
  const totalAssetsYearIb = sumSections(assetSections, (s) => s.subtotal_year_ib)
  const totalAssetsIb = sumSections(assetSections, (s) => s.subtotal_ib)
  const totalEquityLiabilities = sumSections(equityLiabilitySections, (s) => s.subtotal)
  const totalEquityLiabilitiesYearIb = sumSections(
    equityLiabilitySections,
    (s) => s.subtotal_year_ib
  )
  const totalEquityLiabilitiesIb = sumSections(equityLiabilitySections, (s) => s.subtotal_ib)

  // Explain a broken balance instead of leaving a bare differens. The usual
  // cause after multi-year migrations is a prior year whose result was never
  // transferred to equity (see imbalance-diagnosis.ts). Only runs on the
  // unbalanced path and must never break the report itself.
  let imbalanceDiagnosis: BalanceImbalanceDiagnosis | undefined
  const differens = roundOre(totalAssets - totalEquityLiabilities)
  if (Math.abs(differens) >= 0.01) {
    try {
      const untransferred = await findUntransferredResults(supabase, companyId, {
        beforePeriodStart: period?.period_start,
      })
      imbalanceDiagnosis = buildImbalanceDiagnosis(untransferred, differens) ?? undefined
    } catch {
      // Best-effort diagnosis only: the report still renders without it.
    }
  }

  return {
    asset_sections: assetSections.filter((s) => s.rows.length > 0),
    total_assets: totalAssets,
    total_assets_year_ib: totalAssetsYearIb,
    total_assets_ib: totalAssetsIb,
    total_assets_period_change: roundOre(totalAssets - totalAssetsIb),
    equity_liability_sections: equityLiabilitySections.filter((s) => s.rows.length > 0),
    total_equity_liabilities: totalEquityLiabilities,
    total_equity_liabilities_year_ib: totalEquityLiabilitiesYearIb,
    total_equity_liabilities_ib: totalEquityLiabilitiesIb,
    total_equity_liabilities_period_change: roundOre(
      totalEquityLiabilities - totalEquityLiabilitiesIb
    ),
    period: {
      start: options?.fromDate ?? fiscalYearStart,
      end: options?.toDate ?? fiscalYearEnd,
    },
    fiscal_year: { start: fiscalYearStart, end: fiscalYearEnd },
    ...(imbalanceDiagnosis ? { imbalance_diagnosis: imbalanceDiagnosis } : {}),
  }
}

function sumCreditPositive(
  rows: TrialBalanceRow[],
  pick: (row: TrialBalanceRow) => number
): number {
  return roundOre(rows.reduce((sum, r) => sum + pick(r), 0))
}

function sumSections(
  sections: BalanceSheetSection[],
  pick: (section: BalanceSheetSection) => number
): number {
  return roundOre(sections.reduce((sum, s) => sum + pick(s), 0))
}

function buildBalanceSections(
  rows: TrialBalanceRow[],
  groupLabels: Record<string, string>,
  normalBalance: 'debit' | 'credit'
): BalanceSheetSection[] {
  const sections: BalanceSheetSection[] = []
  const signed = (debit: number, credit: number) =>
    normalBalance === 'debit' ? debit - credit : credit - debit

  for (const [groupCode, title] of Object.entries(groupLabels)) {
    const groupRows = rows.filter((r) => r.account_number.startsWith(groupCode))
    if (groupRows.length === 0) continue

    const sectionRows = groupRows.map((r) => {
      const amount = roundOre(signed(r.closing_debit, r.closing_credit))
      const ib = roundOre(signed(r.opening_debit, r.opening_credit))

      return {
        account_number: r.account_number,
        account_name: r.account_name,
        amount,
        year_ib: roundOre(signed(r.year_opening_debit, r.year_opening_credit)),
        ib,
        period_change: roundOre(amount - ib),
      }
    })

    // An account settled to zero inside the window still has an opening
    // figure, and dropping it would leave the Ingående columns not summing to
    // their subtotal. Only a row that is empty in every column goes away.
    const keptRows = sectionRows.filter(
      (r) =>
        Math.abs(r.amount) > 0.005 ||
        Math.abs(r.year_ib) > 0.005 ||
        Math.abs(r.ib) > 0.005
    )

    const subtotal = roundOre(sectionRows.reduce((sum, r) => sum + r.amount, 0))
    const subtotalIb = roundOre(sectionRows.reduce((sum, r) => sum + r.ib, 0))

    sections.push({
      title,
      rows: keptRows,
      subtotal,
      subtotal_year_ib: roundOre(sectionRows.reduce((sum, r) => sum + r.year_ib, 0)),
      subtotal_ib: subtotalIb,
      subtotal_period_change: roundOre(subtotal - subtotalIb),
    })
  }

  return sections
}
