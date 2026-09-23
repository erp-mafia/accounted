/**
 * Which pay month a salary run gets when the caller names none.
 *
 * "Starta lönekörning" on the Löner page is one click: it used to POST {} and
 * let the route pick the month, while the button itself never said which one.
 * With September still open as a draft, a second click created, calculated
 * and opened October without a word. The rule now lives here, once, so the
 * button can name the month it is about to create and the route resolves the
 * same month for every caller that still sends no period (API, MCP).
 *
 * The rule: the month after the latest live run; with no live run, the month
 * `now` falls in. A corrected run is not live (its correction run carries the
 * period), which is the same exclusion the route's duplicate check uses.
 *
 * Pure: this file is imported by a client component.
 */

export interface RunPeriod {
  period_year: number
  period_month: number
}

/** A salary_runs row, as far as this rule reads it. Supabase rows are untyped, hence the loose values. */
export interface RunPeriodSource {
  period_year: number | string
  period_month: number | string
  status?: string | null
}

/**
 * `now` is read with the local getters. On the server that is the server's
 * time zone, in the browser the user's, and the two can differ for a few hours
 * around a month boundary. The Löner page therefore sends the period it shows,
 * so a click always creates the month the button named.
 */
export function nextRunPeriod(runs: readonly RunPeriodSource[], now: Date): RunPeriod {
  let latest: RunPeriod | null = null
  for (const run of runs) {
    if (run.status === 'corrected') continue
    const year = Number(run.period_year)
    const month = Number(run.period_month)
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) continue
    if (
      !latest ||
      year > latest.period_year ||
      (year === latest.period_year && month > latest.period_month)
    ) {
      latest = { period_year: year, period_month: month }
    }
  }
  if (!latest) {
    return { period_year: now.getFullYear(), period_month: now.getMonth() + 1 }
  }
  return latest.period_month === 12
    ? { period_year: latest.period_year + 1, period_month: 1 }
    : { period_year: latest.period_year, period_month: latest.period_month + 1 }
}
