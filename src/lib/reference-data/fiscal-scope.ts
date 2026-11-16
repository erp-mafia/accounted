/**
 * Initial fiscal-year scope resolution shared by FyPicker and
 * FiscalYearSelector. Pure so the restore rules (persisted choice, "all
 * years", newest started period, most recently ended period) can be tested
 * without React, and so both pickers cannot drift apart again.
 */

import type { FiscalPeriod } from '@/types'
import { ALL_YEARS_VALUE } from '@/components/common/fiscal-year-storage'
import { hasEnded, todayIsoStockholm } from '@/lib/dates/iso'

/** Newest first; optionally drops periods that have not started yet. */
export function prepareFiscalPeriods(
  periods: readonly FiscalPeriod[],
  hideFuturePeriods: boolean,
  today: string = todayIsoStockholm(),
): FiscalPeriod[] {
  return periods
    .filter((p) => !hideFuturePeriods || p.period_start <= today)
    .sort((a, b) => b.period_start.localeCompare(a.period_start))
}

/**
 * The periods a year-end flow can close: ended (hasEnded: the last day has
 * passed), not closed, no closing entry yet. Oldest first, since accountants
 * close in order.
 */
export function closableFiscalPeriods(periods: FiscalPeriod[], today = todayIsoStockholm()): FiscalPeriod[] {
  return periods
    .filter((p) => !p.is_closed && !p.closing_entry_id && hasEnded(p.period_end, today))
    .sort((a, b) => a.period_start.localeCompare(b.period_start))
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
    const today = options.today ?? todayIsoStockholm()
    const pick = periods.find((p) => hasEnded(p.period_end, today)) ?? newest
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

/**
 * The app-wide fiscal-year choice on its first load (Stil v3: the year is
 * context beside the company name, not a per-page picker). A persisted
 * "all years" or period id wins; otherwise the newest period that has
 * started, so the sidebar opens on the current year. `periods` newest first.
 */
export function resolveAppFiscalChoice(
  periods: readonly FiscalPeriod[],
  stored: string | null,
  today: string = todayIsoStockholm(),
): string | null {
  if (stored === ALL_YEARS_VALUE) return null
  if (stored && periods.some((p) => p.id === stored)) return stored
  const started = periods.find((p) => p.period_start <= today) ?? periods[0] ?? null
  return started?.id ?? null
}

export interface EffectiveScopeOptions {
  /** Whether "all years" is a valid scope on this surface (a report needs one year). */
  allowAll?: boolean
  /** Surfaces that only make sense for a started year (reports): a future pick falls back. */
  hideFuture?: boolean
  today?: string
}

/**
 * The scope a page actually uses, derived from the app-wide choice and the
 * page's own constraints, so one sidebar choice serves every page without
 * any page being able to land on a scope it cannot show. Falls back to the
 * newest started period (or the newest at all) when the choice does not fit.
 * `periods` newest first; `choice` null means "all years".
 */
export function effectiveFiscalScope(
  periods: readonly FiscalPeriod[],
  choice: string | null,
  options: EffectiveScopeOptions = {},
): FiscalScopePick {
  const today = options.today ?? todayIsoStockholm()
  const allowAll = options.allowAll ?? true
  const usable = options.hideFuture ? periods.filter((p) => p.period_start <= today) : periods
  const fallback = usable.find((p) => p.period_start <= today) ?? usable[0] ?? null
  if (choice === null) {
    if (allowAll) return { periodId: null, period: null }
    return { periodId: fallback?.id ?? null, period: fallback }
  }
  const picked = usable.find((p) => p.id === choice)
  if (picked) return { periodId: picked.id, period: picked }
  return { periodId: fallback?.id ?? null, period: fallback }
}
