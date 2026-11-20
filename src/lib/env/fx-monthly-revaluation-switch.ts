import { flagEnabled } from '@/lib/env/public-flags'

/**
 * NEXT_PUBLIC_FX_MONTHLY_REVALUATION_ENABLED: the monthly currency
 * revaluation (#523): the setting row, the "Omvärdera per månadsskifte"
 * action and its route. Unset = off until the operator flips it. A company
 * still has to choose monthly revaluation itself
 * (company_settings.fx_revaluation_monthly); the switch only shows the choice.
 */
export function fxMonthlyRevaluationEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_FX_MONTHLY_REVALUATION_ENABLED)
}
