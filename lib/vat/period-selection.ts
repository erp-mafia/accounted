/**
 * Initial period selection for the VAT declaration view.
 *
 * The view seeds its cadence (month/quarter/räkenskapsår) from the company's
 * configured redovisningsperiod (company_settings.moms_period) and its
 * concrete period from the most recently ended one (period-defaults.ts), the
 * only one that can actually be filed.
 *
 * The cadence is deliberately NOT persisted across visits: a company's
 * redovisningsperiod is fixed by its Skatteverket registration (SFL 26 kap),
 * so the setting has exactly one lawful value and the mount-time re-seed is
 * the control that self-heals a temporary in-session detour (e.g. a
 * helårsmoms user peeking at quarterly figures). Restoring such a detour
 * would keep the filing pipeline open on the wrong period type. The yearly
 * cadence's räkenskapsår pick is persisted by FyPicker, which is fine: every
 * fiscal year is a legitimate target.
 */

import { mostRecentEndedVatPeriod } from './period-defaults'
import type { MomsPeriod, VatPeriodType } from '@/types'

export interface VatPeriodSelection {
  periodType: VatPeriodType
  year: number
  /** 1-12 for monthly, 1-4 for quarterly, always 1 for yearly. */
  period: number
}

/**
 * Decide the view's initial period from the company's moms_period setting:
 * the setting's cadence, seeded to the most recently ended period in it.
 */
export function resolveInitialVatPeriodSelection(opts: {
  momsPeriod: MomsPeriod | null
  over40m: boolean
  today?: Date
}): VatPeriodSelection {
  const { momsPeriod, over40m } = opts
  const today = opts.today ?? new Date()

  // The 'quarterly' fallback only shapes state that is never shown: the view
  // gates on a missing moms_period (and on a missing settings row) before
  // rendering a declaration.
  const cadence = momsPeriod ?? 'quarterly'

  if (cadence === 'yearly') {
    return { periodType: 'yearly', year: today.getFullYear(), period: 1 }
  }
  const ended = mostRecentEndedVatPeriod(cadence, today, { over40m })
  return { periodType: cadence, year: ended.year, period: ended.period }
}
