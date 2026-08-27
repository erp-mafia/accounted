/**
 * Initial period selection for the VAT declaration view.
 *
 * The view seeds its cadence (month/quarter/räkenskapsår) from the company's
 * configured redovisningsperiod (company_settings.moms_period) and its
 * concrete period from the most recently ended one (period-defaults.ts). A
 * manual cadence change used to evaporate on every visit; it is now persisted
 * per company (components/common/vat-period-storage.ts) and restored here.
 *
 * Only the CADENCE is persisted, never the concrete year/period: the concrete
 * default is deadline-aware on purpose (the most recently ended period is the
 * one that can actually be filed), and restoring a months-old manual pick
 * would open the view on a stale period at the next filing. The yearly
 * cadence's räkenskapsår pick is persisted separately by FyPicker.
 *
 * A stored cadence carries the moms_period it was chosen under and is
 * discarded when the setting has changed since: the setting is the
 * authoritative cadence (it also drives the deadline engine), so after the
 * user corrects it in Inställningar the view must follow the new setting,
 * not a picker choice made under the old one.
 */

import { mostRecentEndedVatPeriod } from './period-defaults'
import type { MomsPeriod, VatPeriodType } from '@/types'

export interface VatPeriodSelection {
  periodType: VatPeriodType
  year: number
  /** 1-12 for monthly, 1-4 for quarterly, always 1 for yearly. */
  period: number
}

export interface StoredVatCadence {
  periodType: VatPeriodType
  /** The company's moms_period setting when the cadence was chosen. */
  momsPeriod: MomsPeriod | null
}

const PERIOD_TYPES: readonly VatPeriodType[] = ['monthly', 'quarterly', 'yearly']

function isPeriodType(value: unknown): value is VatPeriodType {
  return typeof value === 'string' && PERIOD_TYPES.includes(value as VatPeriodType)
}

/** Parse a persisted cadence; anything malformed resolves to null. */
export function parseStoredVatCadence(raw: string | null): StoredVatCadence | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  if (!isPeriodType(candidate.periodType)) return null
  if (candidate.momsPeriod !== null && !isPeriodType(candidate.momsPeriod)) return null
  return {
    periodType: candidate.periodType,
    momsPeriod: (candidate.momsPeriod ?? null) as MomsPeriod | null,
  }
}

/**
 * Decide the view's initial period: cadence from a persisted manual choice
 * when it was made under the current moms_period setting (otherwise from the
 * setting itself), concrete period always the most recently ended one in
 * that cadence.
 */
export function resolveInitialVatPeriodSelection(opts: {
  stored: StoredVatCadence | null
  momsPeriod: MomsPeriod | null
  over40m: boolean
  today?: Date
}): VatPeriodSelection {
  const { stored, momsPeriod, over40m } = opts
  const today = opts.today ?? new Date()

  // The 'quarterly' fallback only shapes state that is never shown: the view
  // gates on a missing moms_period before rendering a declaration.
  const cadence =
    stored && stored.momsPeriod === momsPeriod ? stored.periodType : (momsPeriod ?? 'quarterly')

  if (cadence === 'yearly') {
    return { periodType: 'yearly', year: today.getFullYear(), period: 1 }
  }
  const ended = mostRecentEndedVatPeriod(cadence, today, { over40m })
  return { periodType: cadence, year: ended.year, period: ended.period }
}
