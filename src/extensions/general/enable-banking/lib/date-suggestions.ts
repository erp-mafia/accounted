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

export interface GapFillSuggestion {
  /** Date of the newest transaction this connection has already imported. */
  latestImportedDate: string
  /**
   * Suggested sync start: latestImportedDate minus GAP_FILL_OVERLAP_DAYS,
   * clamped to today (UTC) so the backend accepts it.
   */
  suggestedStartDate: string
}

/**
 * Overlap requested before the newest already-imported row. The external_id
 * dedup makes re-imported rows no-ops, so the overlap costs nothing, and it
 * catches transactions the bank booked late around the boundary.
 */
export const GAP_FILL_OVERLAP_DAYS = 7

/**
 * Turn the newest transaction a connection has already imported into a
 * "continue where the last fetch stopped" suggestion for RENEWALS.
 *
 * A reconnect walks the same pending_selection → active flow as a first
 * connect, and a fresh consent often makes the bank release history the first
 * connect never delivered. Re-requesting a long lookback then floods the inbox
 * with rows over already-bookkept periods (the 2026-08 renewal flood), so a
 * renewal should default to fetching only the gap since the last import.
 * Returns null when the connection has never imported anything: a first
 * connect has no gap to fill.
 */
export function resolveGapFillStart(
  latestImportedDate: string | null | undefined,
  today: Date = new Date(),
): GapFillSuggestion | null {
  if (!latestImportedDate) return null
  const d = new Date(latestImportedDate + 'T00:00:00Z')
  if (!Number.isFinite(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() - GAP_FILL_OVERLAP_DAYS)
  let start = d.toISOString().split('T')[0]
  // The backend clamps every lookback to 365 days. A renewal staler than that
  // must show the date the backfill will actually start from, not promise a
  // gap it cannot fill (the >90-day helper already points at SIE/file import
  // for older history).
  const floor = new Date(today.getTime())
  floor.setUTCDate(floor.getUTCDate() - 365)
  const floorUtc = floor.toISOString().split('T')[0]
  if (start < floorUtc) start = floorUtc
  // The backend PATCH handler rejects initial_lookback_from_date unless it is
  // strictly in the past; today (UTC) is the newest value it accepts. A
  // latestImportedDate in the future can only come from bad bank data: clamp
  // rather than propagate it.
  const todayUtc = today.toISOString().split('T')[0]
  return {
    latestImportedDate,
    suggestedStartDate: start <= todayUtc ? start : todayUtc,
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
