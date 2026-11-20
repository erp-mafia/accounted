import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'
import { formatCurrency } from '@/lib/utils'
import type { BalanceImbalanceDiagnosis, UntransferredResult } from '@/types'

/**
 * Find fiscal years whose result was never booked into equity.
 *
 * A period is a culprit when a chronologically later period exists AND its
 * P&L accounts (class 3-8) do not net to zero. The running (latest) year
 * legitimately carries its result on class 3-8 until bokslut, so it is
 * never flagged.
 *
 * Such a result no longer unbalances a later year: the derived opening
 * balance carries it on the form's closing account
 * (prior_opening_balance_lines, migration 20261024140000). The SIE import
 * still names these years, because the year itself has no booked
 * resultatavslut.
 *
 * Cost: one trial balance per candidate period, so it runs right after an
 * SIE import only.
 */
export async function findUntransferredResults(
  supabase: SupabaseClient,
  companyId: string,
  options?: { beforePeriodStart?: string }
): Promise<UntransferredResult[]> {
  const { data: periods } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start')
    .eq('company_id', companyId)
    .order('period_start', { ascending: true })

  if (!Array.isArray(periods) || periods.length < 2) {
    return []
  }

  // Every period except the chronologically last is a candidate; an
  // explicit beforePeriodStart narrows to periods before the caller's year
  // (later years never leak backwards into earlier IB).
  let candidates = periods.slice(0, -1) as Array<{
    id: string
    name: string
    period_start: string
  }>
  if (options?.beforePeriodStart) {
    const cutoff = options.beforePeriodStart
    candidates = candidates.filter((p) => p.period_start < cutoff)
  }

  const culprits: UntransferredResult[] = []
  for (const period of candidates) {
    const { rows } = await generateTrialBalance(supabase, companyId, period.id, {
      // Diagnostics must see the ledger exactly as posted.
      closingEntry: 'include',
    })
    const plNet = roundOre(
      rows
        .filter((r) => r.account_class >= 3 && r.account_class <= 8)
        .reduce((sum, r) => sum + (r.closing_credit - r.closing_debit), 0)
    )
    if (Math.abs(plNet) >= ORE_TOLERANCE) {
      culprits.push({
        fiscal_period_id: period.id,
        period_name: period.name,
        pl_net: plNet,
      })
    }
  }

  return culprits
}

function sek(amount: number): string {
  return formatCurrency(amount, 'SEK', { minimumFractionDigits: 2 })
}

/**
 * Build the user-facing explanation for an unbalanced balance report.
 * Returns null when the differens is below one öre (nothing to explain).
 * An earlier year's untransferred result used to be the usual cause; the
 * derived opening balance now carries it, so no cause is known that the
 * books could name. The message is Swedish (user-facing domain messages are
 * Swedish).
 */
export function buildImbalanceDiagnosis(differens: number): BalanceImbalanceDiagnosis | null {
  const rounded = roundOre(differens)
  if (Math.abs(rounded) < 0.01) {
    return null
  }

  return {
    differens: rounded,
    message:
      `Balansrapporten balanserar inte (differens ${sek(Math.abs(rounded))}). ` +
      'Ingen orsak kunde fastställas automatiskt: kontrollera tidigare års bokslut och ingående balanser.',
  }
}
