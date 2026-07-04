/**
 * Parse and validate optional `from_date` / `to_date` query params for the
 * date-range-aware financial reports (resultat- and balansrapport).
 *
 * Returns the bounds clamped against the fiscal period. Both params are
 * optional: when omitted, the report falls back to the period as a whole.
 * Returns a `{ error }` shape on invalid input so callers can map it to a
 * 400 response without each route duplicating the same checks.
 */
export type DateRange = { fromDate?: string; toDate?: string }

export type DateRangeResult =
  | { ok: true; range: DateRange }
  | { ok: false; error: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function parseReportDateRange(
  searchParams: URLSearchParams,
  period: { period_start: string; period_end: string }
): DateRangeResult {
  const rawFrom = searchParams.get('from_date')
  const rawTo = searchParams.get('to_date')

  if (rawFrom && !ISO_DATE.test(rawFrom)) {
    return { ok: false, error: 'from_date måste vara på formen YYYY-MM-DD.' }
  }
  if (rawTo && !ISO_DATE.test(rawTo)) {
    return { ok: false, error: 'to_date måste vara på formen YYYY-MM-DD.' }
  }

  const fromDate = rawFrom ?? undefined
  const toDate = rawTo ?? undefined

  if (fromDate && (fromDate < period.period_start || fromDate > period.period_end)) {
    return {
      ok: false,
      error: `from_date måste ligga inom räkenskapsåret (${period.period_start}: ${period.period_end}).`,
    }
  }
  if (toDate && (toDate < period.period_start || toDate > period.period_end)) {
    return {
      ok: false,
      error: `to_date måste ligga inom räkenskapsåret (${period.period_start}: ${period.period_end}).`,
    }
  }
  if (fromDate && toDate && fromDate > toDate) {
    return { ok: false, error: 'from_date får inte vara efter to_date.' }
  }

  return { ok: true, range: { fromDate, toDate } }
}
