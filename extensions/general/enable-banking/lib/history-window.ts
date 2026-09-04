/**
 * Day arithmetic for the transactions history window (date_from .. date_to,
 * both YYYY-MM-DD, evaluated in UTC).
 *
 * Shared by api-client.ts (the narrowing ladder) and sync.ts (recording the
 * widest window a bank has accepted for an account, issue #2202). It lives in
 * its own module because sync.test.ts mocks api-client wholesale: a helper
 * exported from there would be undefined under test.
 */
const DAY_MS = 24 * 60 * 60 * 1000

function parseUtcDay(value: string | undefined): number | undefined {
  if (!value) return undefined
  const t = new Date(`${value}T00:00:00Z`).getTime()
  return Number.isFinite(t) ? t : undefined
}

/**
 * Whole days from dateFrom to dateTo. Undefined when either end is missing or
 * unparseable, or when the window is negative: callers treat undefined as
 * "no width known", never as 0.
 */
export function historyWindowDays(
  dateFrom: string | undefined,
  dateTo: string | undefined
): number | undefined {
  const from = parseUtcDay(dateFrom)
  const to = parseUtcDay(dateTo)
  if (from === undefined || to === undefined) return undefined
  const days = Math.round((to - from) / DAY_MS)
  return days >= 0 ? days : undefined
}

/** The YYYY-MM-DD that lies `days` days before dateTo; undefined when dateTo is unparseable. */
export function dateFromDaysBefore(dateTo: string | undefined, days: number): string | undefined {
  const to = parseUtcDay(dateTo)
  if (to === undefined) return undefined
  return new Date(to - days * DAY_MS).toISOString().split('T')[0]
}
