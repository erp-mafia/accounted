/**
 * Where the bank history starts, said as one sentence. On the migration
 * path the day after the last imported verifikat (the bank takes over where
 * the old system stopped); otherwise 90 days, the longest most banks hand
 * out without narrowing. Räkenskapsårets början and a free date sit behind
 * Ändra. Beyond 90 days the caller shows the Swedbank line.
 */

export type LookbackMode = 'auto' | '90' | 'fy' | 'date'

export interface LookbackInput {
  mode: LookbackMode
  /** ISO date of the last posted verifikat, or null. */
  lastEntryDate: string | null
  /** ISO date the current fiscal year starts. */
  fiscalYearStart: string | null
  /** ISO date the user typed for mode 'date'. */
  customDate: string | null
  /** ISO today. */
  today: string
}

export interface LookbackResult {
  /** What the request carries: a from-date wins over days. */
  body: { initial_lookback_from_date: string } | { initial_lookback_days: number }
  /** The resolved start, ISO, for the sentence and the chart. */
  fromDate: string
  days: number
  /** Which rule produced it (the sentence differs). */
  rule: 'after_last_entry' | '90_days' | 'fiscal_year' | 'date'
}

const DAY_MS = 86_400_000

export function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  return Math.max(0, Math.round((b - a) / DAY_MS))
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

export function resolveLookback(input: LookbackInput): LookbackResult {
  const ninety = (): LookbackResult => ({
    body: { initial_lookback_days: 90 },
    fromDate: isoAddDays(input.today, -90),
    days: 90,
    rule: '90_days',
  })
  const fromDate = (iso: string, rule: LookbackResult['rule']): LookbackResult => ({
    body: { initial_lookback_from_date: iso },
    fromDate: iso,
    days: daysBetween(iso, input.today),
    rule,
  })

  switch (input.mode) {
    case '90':
      return ninety()
    case 'fy':
      return input.fiscalYearStart && ISO.test(input.fiscalYearStart) && input.fiscalYearStart < input.today
        ? fromDate(input.fiscalYearStart, 'fiscal_year')
        : ninety()
    case 'date':
      return input.customDate && ISO.test(input.customDate) && input.customDate < input.today
        ? fromDate(input.customDate, 'date')
        : ninety()
    case 'auto':
    default: {
      if (input.lastEntryDate && ISO.test(input.lastEntryDate)) {
        const next = isoAddDays(input.lastEntryDate, 1)
        // A last verifikat in the future (or today) means nothing to fill: 90 days.
        if (next < input.today) return fromDate(next, 'after_last_entry')
      }
      return ninety()
    }
  }
}

/** The server clamps a from-date to 365 days: say so before the request. */
export const LOOKBACK_MAX_DAYS = 365
/** Beyond this some banks (Swedbank among them) abort the consent. */
export const LOOKBACK_SAFE_DAYS = 90
