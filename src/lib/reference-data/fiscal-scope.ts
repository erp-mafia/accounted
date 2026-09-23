/**
 * Initial fiscal-year scope resolution shared by FyPicker and
 * FiscalYearSelector. Pure so the restore rules (persisted choice, "all
 * years", newest started period, most recently ended period) can be tested
 * without React, and so both pickers cannot drift apart again.
 */

import type { FiscalPeriod } from '@/types'
import { ALL_YEARS_VALUE } from '@/components/common/fiscal-year-storage'
import { todayIsoUtc } from '@/lib/dates/iso'

/** Newest first; optionally drops periods that have not started yet. */
export function prepareFiscalPeriods(
  periods: readonly FiscalPeriod[],
  hideFuturePeriods: boolean,
  today: string = todayIsoUtc(),
): FiscalPeriod[] {
  return periods
    .filter((p) => !hideFuturePeriods || p.period_start <= today)
    .sort((a, b) => b.period_start.localeCompare(a.period_start))
}

export interface FiscalScopeOptions {
  /** Whether "all years" (null) is a valid selection on this surface. */
  includeAllOption: boolean
  /**
   * Filing surfaces: ignore the persisted choice and open on the most
   * recently ended period (only an ended year can be declared).
   */
  preferLatestEnded?: boolean
  today?: string
}

export interface FiscalScopePick {
  periodId: string | null
  period: FiscalPeriod | null
}

/**
 * What the picker should select on load, or null when nothing should be
 * auto-selected. `periods` must already be prepared (newest first);
 * `stored` is the raw persisted value for this company (or null).
 */
export function resolveInitialFiscalScope(
  periods: readonly FiscalPeriod[],
  stored: string | null,
  options: FiscalScopeOptions,
): FiscalScopePick | null {
  const newest = periods[0] ?? null

  if (options.preferLatestEnded) {
    const today = options.today ?? todayIsoUtc()
    const pick = periods.find((p) => p.period_end < today) ?? newest
    return pick ? { periodId: pick.id, period: pick } : null
  }

  if (stored === ALL_YEARS_VALUE) {
    if (options.includeAllOption) return { periodId: null, period: null }
    return newest ? { periodId: newest.id, period: newest } : null
  }

  if (stored) {
    const match = periods.find((p) => p.id === stored)
    if (match) return { periodId: match.id, period: match }
  }

  if (!options.includeAllOption && newest) {
    return { periodId: newest.id, period: newest }
  }

  return null
}
