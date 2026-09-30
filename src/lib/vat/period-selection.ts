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
 * would keep the filing pipeline open on the wrong period type.
 *
 * All three cadences seed the same way. A yearly period is the räkenskapsår,
 * keyed by the calendar year it ends in (lib/vat/filing-record.ts), so the
 * seed needs the company's fiscal-year end month to place it.
 */

import {
  compareVatPeriods,
  currentVatPeriod,
  mostRecentEndedVatPeriod,
  nextVatPeriod,
} from './period-defaults'
import type { MomsPeriod, VatPeriodType } from '@/types'

export interface VatPeriodSelection {
  periodType: VatPeriodType
  /** Calendar year of the period; for yearly, the year the räkenskapsår ends. */
  year: number
  /** 1-12 for monthly, 1-4 for quarterly, always 1 for yearly. */
  period: number
}

/**
 * Decide the view's initial period from the company's moms_period setting:
 * the setting's cadence, seeded to the most recently ended period in it.
 *
 * `isFiled` (issues #2746, #2786): when the most recently ended period is
 * already recorded as filed (through the Skatteverket connection or marked by
 * hand), the seed steps forward past every filed period, but never past the
 * period running today. A quarterly filer who filed Q2 in August lands on Q3
 * instead of reopening a finished declaration on every visit until October; a
 * helårsmoms filer who filed last räkenskapsår lands on the running one.
 */
export function resolveInitialVatPeriodSelection(opts: {
  momsPeriod: MomsPeriod | null
  over40m: boolean
  /** Month (1-12) the räkenskapsår ends; places yearly periods. Default 12. */
  fiscalYearEndMonth?: number
  today?: Date
  isFiled?: (periodType: VatPeriodType, year: number, period: number) => boolean
}): VatPeriodSelection {
  const { momsPeriod, over40m, fiscalYearEndMonth, isFiled } = opts
  const today = opts.today ?? new Date()

  // The 'quarterly' fallback only shapes state that is never shown: the view
  // gates on a missing moms_period (and on a missing settings row) before
  // rendering a declaration.
  const cadence = momsPeriod ?? 'quarterly'

  let selected = mostRecentEndedVatPeriod(cadence, today, { over40m, fiscalYearEndMonth })
  if (isFiled) {
    const current = currentVatPeriod(cadence, today, { fiscalYearEndMonth })
    while (
      compareVatPeriods(selected, current) < 0 &&
      isFiled(cadence, selected.year, selected.period)
    ) {
      selected = nextVatPeriod(cadence, selected)
    }
  }
  return { periodType: cadence, year: selected.year, period: selected.period }
}

/**
 * The räkenskapsår a yearly VAT period names: the fiscal period that ends in
 * `year` (the key's year), the later one when an omläggning ends two in the
 * same year. Only periods that have started (`period_start <= today`) are
 * candidates, matching the räkenskapsår picker's list. Null when the company
 * has no such fiscal period yet.
 */
export function fiscalPeriodForVatYear<P extends { period_start: string; period_end: string }>(
  periods: readonly P[],
  year: number,
  today: string,
): P | null {
  let match: P | null = null
  for (const candidate of periods) {
    if (!candidate.period_end.startsWith(`${year}-`) || candidate.period_start > today) continue
    if (!match || candidate.period_end > match.period_end) match = candidate
  }
  return match
}
