import type { CompanySettings } from '@/types'
import { getCurrentFiscalYearStart } from '@/lib/company/fiscal-year'

export interface BookedCoverage {
  /** Entry date of the company's latest posted verifikat. */
  lastBookedDate: string
  /**
   * Day after lastBookedDate (the earliest sync start that cannot overlap
   * booked entries), clamped to today (UTC) so the backend accepts it.
   */
  suggestedStartDate: string
}

/**
 * Turn the latest posted verifikat date into a "start syncing from" suggestion.
 *
 * Issue #917: this used to be derived from sie_imports.fiscal_year_end, which
 * is the fiscal PERIOD end, not how far the bookkeeping actually reaches. For
 * a company whose SIE covered an extended first year (2025-10-01 to 2026-12-31)
 * but whose entries stopped in May, the old value suggested a start date past
 * every unbooked transaction. Returns null when there is nothing booked: no
 * suggestion beats a misleading one.
 */
export function resolveBookedCoverage(
  lastPostedEntryDate: string | null | undefined,
  today: Date = new Date(),
): BookedCoverage | null {
  if (!lastPostedEntryDate) return null
  // Pin the math to UTC so the day-after arithmetic is timezone-independent.
  const d = new Date(lastPostedEntryDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  const dayAfter = d.toISOString().split('T')[0]
  // The backend PATCH handler (index.ts) rejects initial_lookback_from_date
  // unless Date.now() is past the date's UTC midnight, so the newest date it
  // accepts is the current UTC date. A company whose latest verifikat is
  // dated today (plausible at initial bank activation) would otherwise get
  // tomorrow suggested here and a 400 when saving. Clamp to today; ISO date
  // strings compare correctly as plain strings.
  const todayUtc = today.toISOString().split('T')[0]
  return {
    lastBookedDate: lastPostedEntryDate,
    suggestedStartDate: dayAfter <= todayUtc ? dayAfter : todayUtc,
  }
}

/**
 * Resolve the start of the current fiscal year, preferring the actual
 * fiscal_periods row that contains today over the recurring
 * fiscal_year_start_month setting.
 *
 * Issue #917: the recurring setting cannot represent an extended or shortened
 * first fiscal year (e.g. 2025-10-01 to 2026-12-31 for a company that later
 * runs calendar years), so deriving from it alone returned 2026-01-01 where
 * the real start was 2025-10-01. The period row is authoritative when it
 * exists; the setting remains the fallback for companies without period rows.
 */
export function resolveFiscalYearStart(
  currentPeriodStart: string | null | undefined,
  settings: Pick<CompanySettings, 'fiscal_year_start_month' | 'entity_type'> | null | undefined,
  today: Date = new Date(),
): string {
  return currentPeriodStart || getCurrentFiscalYearStart(settings, today)
}
