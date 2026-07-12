import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { findUntransferredResults, buildImbalanceDiagnosis } from './imbalance-diagnosis'
import type {
  BalanceImbalanceDiagnosis,
  BalansrapportReport,
  BalansrapportRow,
  BalansrapportGroup,
} from '@/types'

const CLASS_LABELS: Record<number, string> = {
  1: '1 Tillgångar',
  2: '2 Eget kapital, obeskattade reserver, avsättningar och skulder',
}

/**
 * Balansrapport: operational balance report.
 *
 * Lists every account in classes 1-2 with IB, period change, and UB.
 * Unlike Balansräkning (formal, ÅRL Bilaga 1), this keeps account numbers
 * and is meant for ongoing reconciliation, not for årsbokslut/årsredovisning.
 *
 * Sign convention: every row is shown debit-positive (debit - credit). Class 1
 * accounts (debit balance) render positive; class 2 accounts (credit balance)
 * render negative. This matches Fortnox/Visma/Bokio and lets the user verify
 * the balance by adding rows: total_assets_ub + total_equity_liabilities_ub
 * = beraknat_resultat (the running-year P&L residual, 0 after year-end close).
 */
export async function generateBalansrapport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: { fromDate?: string; toDate?: string }
): Promise<BalansrapportReport> {
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    throw new Error('Fiscal period not found')
  }

  const effectiveFromDate = options?.fromDate ?? period.period_start
  const effectiveToDate = options?.toDate ?? period.period_end

  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    fromDate: options?.fromDate,
    toDate: options?.toDate,
  })
  const balanceRows = trialBalance.rows.filter((r) => r.account_class === 1 || r.account_class === 2)

  const groups: BalansrapportGroup[] = []
  for (const klass of [1, 2] as const) {
    const groupRows = balanceRows
      .filter((r) => r.account_class === klass)
      .sort((a, b) => a.account_number.localeCompare(b.account_number))

    const rows: BalansrapportRow[] = []
    let subtotalIb = 0
    let subtotalUb = 0
    for (const r of groupRows) {
      const ib = signedAmount(r.opening_debit, r.opening_credit)
      const ub = signedAmount(r.closing_debit, r.closing_credit)
      const change = round2(ub - ib)
      if (Math.abs(ib) < 0.005 && Math.abs(ub) < 0.005) continue
      rows.push({
        account_number: r.account_number,
        account_name: r.account_name,
        ib: round2(ib),
        ub: round2(ub),
        period_change: change,
      })
      subtotalIb += ib
      subtotalUb += ub
    }

    if (rows.length === 0) continue

    groups.push({
      class: klass,
      class_label: CLASS_LABELS[klass],
      rows,
      subtotal_ib: round2(subtotalIb),
      subtotal_ub: round2(subtotalUb),
    })
  }

  const totalAssetsUb = groups.find((g) => g.class === 1)?.subtotal_ub ?? 0
  const totalEquityLiabilitiesUb = groups.find((g) => g.class === 2)?.subtotal_ub ?? 0

  // Beräknat resultat: the residual on the balance side. With both classes in
  // debit-positive sign, assets are positive and eq_liab is negative; their sum
  // equals the running-year P&L residual. Trial balance guarantees
  // sum_all(debit - credit) = 0, so sum_balance = -sum_pl = revenues - costs.
  // After year-end close posts the result into 2099, the residual is 0.
  const beraknatResultat = round2(totalAssetsUb + totalEquityLiabilitiesUb)

  // An unbalanced trial balance here means the opening balance itself is
  // broken — double-entry guarantees period activity balances. Explain why
  // (usually a prior year's untransferred result) instead of leaving a bare
  // "Balanserar ej". Best-effort: a diagnosis failure never breaks the report.
  let imbalanceDiagnosis: BalanceImbalanceDiagnosis | undefined
  if (!trialBalance.isBalanced) {
    const differens = round2(trialBalance.totalDebit - trialBalance.totalCredit)
    try {
      const untransferred = await findUntransferredResults(supabase, companyId, {
        beforePeriodStart: period.period_start,
      })
      imbalanceDiagnosis = buildImbalanceDiagnosis(untransferred, differens) ?? undefined
    } catch {
      // Best-effort diagnosis only.
    }
  }

  return {
    groups,
    total_assets_ub: totalAssetsUb,
    total_equity_liabilities_ub: totalEquityLiabilitiesUb,
    beraknat_resultat: beraknatResultat,
    is_balanced: trialBalance.isBalanced,
    period: { start: effectiveFromDate, end: effectiveToDate },
    ...(imbalanceDiagnosis ? { imbalance_diagnosis: imbalanceDiagnosis } : {}),
  }
}

function signedAmount(debit: number, credit: number): number {
  return debit - credit
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
