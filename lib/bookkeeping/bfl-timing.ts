/**
 * BFL / BFNAR timing helpers for commit and pre-publish gates (ADR 013).
 *
 * - Cash: must be booked by the next business day (Mon–Fri; Swedish holidays not modelled)
 * - Other: warn after end of following month; block (policy) after 50 days from entry_date
 */

export type BflTimingKind = 'cash' | 'other'

export type BflTimingIssue = {
  severity: 'block' | 'warn'
  code: 'CASH_LATE' | 'OTHER_OVER_50_DAYS' | 'OTHER_PAST_FOLLOWING_MONTH'
  message: string
  entry_date: string
  booked_on: string
  kind: BflTimingKind
}

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map((n) => Number.parseInt(n, 10))
  return new Date(Date.UTC(y!, m! - 1, d!))
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Next Mon–Fri after `ymd` (UTC calendar). */
export function nextBusinessDay(ymd: string): string {
  const d = parseYmd(ymd)
  d.setUTCDate(d.getUTCDate() + 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return toYmd(d)
}

/** Last calendar day of the month following `ymd`'s month. */
export function endOfFollowingMonth(ymd: string): string {
  const d = parseYmd(ymd)
  // Move to first of month after next, then subtract one day
  const following = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0))
  return toYmd(following)
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  const a = parseYmd(fromYmd).getTime()
  const b = parseYmd(toYmd).getTime()
  return Math.floor((b - a) / (24 * 60 * 60 * 1000))
}

/**
 * Evaluate whether booking `bookedOn` for affärshändelse `entryDate` is late.
 * `kind` defaults to other; callers mark cash (1930/cash payments) as cash.
 */
export function evaluateBflTiming(input: {
  entryDate: string
  bookedOn: string
  kind?: BflTimingKind
}): BflTimingIssue | null {
  const kind = input.kind ?? 'other'
  const entry = input.entryDate.slice(0, 10)
  const booked = input.bookedOn.slice(0, 10)

  if (kind === 'cash') {
    const deadline = nextBusinessDay(entry)
    if (booked > deadline) {
      return {
        severity: 'block',
        code: 'CASH_LATE',
        message: `Kontanttransaktion ${entry} måste bokföras senast ${deadline} (BFL 5 kap 2§)`,
        entry_date: entry,
        booked_on: booked,
        kind,
      }
    }
    return null
  }

  const age = daysBetween(entry, booked)
  if (age > 50) {
    return {
      severity: 'block',
      code: 'OTHER_OVER_50_DAYS',
      message: `Affärshändelse ${entry} bokförs ${age} dagar senare (över 50 dagar — BFNAR 2013:2)`,
      entry_date: entry,
      booked_on: booked,
      kind,
    }
  }

  const monthDeadline = endOfFollowingMonth(entry)
  if (booked > monthDeadline) {
    return {
      severity: 'warn',
      code: 'OTHER_PAST_FOLLOWING_MONTH',
      message: `Affärshändelse ${entry} bokförs efter månaden efter (${monthDeadline})`,
      entry_date: entry,
      booked_on: booked,
      kind,
    }
  }

  return null
}

/** Heuristic: description or account hints for cash. */
export function inferCashKind(opts: {
  description?: string | null
  accountNumbers?: string[]
}): BflTimingKind {
  const accounts = opts.accountNumbers ?? []
  if (accounts.some((a) => a === '1910' || a === '1920')) return 'cash'
  const desc = (opts.description ?? '').toLowerCase()
  if (/\bkassa\b|\bcash\b|\bkontant\b/.test(desc)) return 'cash'
  return 'other'
}
