import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'
import { formatCurrency } from '@/lib/utils'
import type { BalanceImbalanceDiagnosis, UntransferredResult } from '@/types'

/**
 * Find fiscal years whose result was never transferred to equity.
 *
 * A period is a culprit when a chronologically later period exists AND its
 * P&L accounts (class 3-8) do not net to zero. The running (latest) year
 * legitimately carries its result on class 3-8 until bokslut, so it is
 * never flagged.
 *
 * Why this signal and not validateBalanceContinuity(): when a period has no
 * opening_balance entry, its IB is derived by summing all prior class 1-2
 * lines (compute_prior_opening_balances). Prior-period UB and derived IB
 * then match per-account BY CONSTRUCTION — the continuity check passes even
 * though the balance sheet is broken. The invariant that actually breaks is
 * "every non-latest year's P&L nets to zero": an untransferred result makes
 * every later derived IB unbalanced by exactly that residual.
 *
 * Cost: one trial balance per candidate period — callers only invoke this
 * when a report is already unbalanced or right after an SIE import.
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
  // explicit beforePeriodStart narrows to periods that can actually affect
  // the caller's report (later years never leak backwards into earlier IB).
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
    const { rows } = await generateTrialBalance(supabase, companyId, period.id)
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
 * The message is Swedish — user-facing domain messages are Swedish.
 */
export function buildImbalanceDiagnosis(
  untransferred: UntransferredResult[],
  differens: number
): BalanceImbalanceDiagnosis | null {
  const rounded = roundOre(differens)
  if (Math.abs(rounded) < 0.01) {
    return null
  }

  if (untransferred.length === 0) {
    return {
      differens: rounded,
      untransferred_results: [],
      message:
        `Balansrapporten balanserar inte (differens ${sek(Math.abs(rounded))}). ` +
        'Ingen orsak kunde fastställas automatiskt — kontrollera tidigare års bokslut och ingående balanser.',
    }
  }

  const yearList = untransferred
    .map((u) => `${u.period_name} (${sek(u.pl_net)})`)
    .join(', ')
  const message =
    untransferred.length === 1
      ? `Differensen beror på att resultatet för ${yearList} aldrig har förts om till eget kapital. ` +
        'Bokför omföring av årets resultat (konto 8999 mot eget kapital, t.ex. 2099) i det året.'
      : `Differensen beror på att resultatet för följande räkenskapsår aldrig har förts om till eget kapital: ${yearList}. ` +
        'Bokför omföring av årets resultat (konto 8999 mot eget kapital, t.ex. 2099) i respektive år.'

  return {
    differens: rounded,
    untransferred_results: untransferred,
    message,
  }
}
