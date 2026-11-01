/**
 * Pure helpers for proposing a new fiscal period (räkenskapsår) in the
 * "Skapa räkenskapsår" dialog. Kept framework-free so they can be unit-tested
 * in isolation (component code itself is not under test per the project's
 * lib/ + app/api/ test scope).
 *
 * All date math runs in UTC. Local-time `Date` arithmetic combined with
 * `toISOString()` shifts dates by the timezone offset (e.g. CET turns
 * 2024-12-31 into 2025-12-30), which silently corrupts period boundaries.
 */

import type { FiscalPeriod } from '@/types'
import { addDaysIso as addDays, addMonthsIso } from '@/lib/dates/iso'

/** Minimal shape needed for the date math: `FiscalPeriod` satisfies it. */
type PeriodRange = Pick<FiscalPeriod, 'period_start' | 'period_end'>

/** A period plus its id, for resolving which räkenskapsår a view scopes to. */
type IdentifiablePeriod = Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>

export interface SuggestedPeriod {
  name: string
  period_start: string
  period_end: string
}

/** A räkenskapsår's first and last day. */
export interface FiscalYearRange {
  start: string
  end: string
}

/**
 * A fiscal-year name: `Räkenskapsår 2025`, or `Räkenskapsår 2024/2025` when it
 * straddles two calendar years. Swedish by default to match the app's existing
 * fiscal-year naming (Swedish-first); the field stays editable in the dialog.
 * Exported so the create dialog can keep the name in step with the dates the
 * user actually types: a suggested "Räkenskapsår 2027" must not survive the
 * user re-dating the year to 2022-07-01..2023-12-31. Callers pass full
 * YYYY-MM-DD strings.
 */
export function fiscalYearName(start: string, end: string): string {
  const startYear = start.slice(0, 4)
  const endYear = end.slice(0, 4)
  return startYear === endYear ? `Räkenskapsår ${startYear}` : `Räkenskapsår ${startYear}/${endYear}`
}

const periodName = fiscalYearName

/**
 * True when `name` has the shape fiscalYearName() produces ("Räkenskapsår
 * 2025", "Räkenskapsår 2024/2025"), whatever the years say. The edit dialog
 * lets such a name follow the dates the user types, so a seed name that never
 * matched its dates (the "Räkenskapsår 2027" on a 2022/2023 year of #2286) is
 * corrected together with them; a hand-written name is left alone.
 */
export function isDerivedFiscalYearName(name: string): boolean {
  return /^Räkenskapsår \d{4}(\/\d{4})?$/.test(name.trim())
}

/**
 * The year part of a generated fiscal-year name, for a surface that already
 * labels the value "Räkenskapsår" (the "Räkenskapsår:" line of a new
 * verifikat, the Räkenskapsår settings list). The app generates three name
 * shapes that all bake the noun in: "Räkenskapsår 2026" (create dialog, SIE
 * import, onboarding), "Första räkenskapsåret 2026" (the onboarding first
 * year) and "FY 2026" (the next year opened at year end), each with a
 * "2025/2026" form for a year that straddles two calendar years. Shown under
 * the label as is, they read "Räkenskapsår: Räkenskapsår 2026" (crm#1380), and
 * in English the Swedish noun sits next to "Fiscal year". Those shapes give
 * "2026" or "2025/2026"; a name the user wrote stays whole.
 */
export function fiscalYearShortName(name: string): string {
  const trimmed = name.trim()
  const generated = /^(?:Räkenskapsår|Första räkenskapsåret|FY) (\d{4}(?:\/\d{4})?)$/.exec(trimmed)
  return generated ? generated[1] : trimmed
}

/**
 * The räkenskapsår after one ending on `latestPeriodEnd`: it starts the next
 * day and runs twelve months. A year on record decides the next one, also
 * after a broken or re-laid first year; fiscal_year_start_month only fills
 * what nothing records. A first or re-laid year of another length is recorded
 * by whoever decides it, never derived here.
 */
export function nextFiscalYearRange(latestPeriodEnd: string): FiscalYearRange {
  const start = addDays(latestPeriodEnd, 1)
  return { start, end: addDays(addMonthsIso(start, 12), -1) }
}

/**
 * The twelve-month räkenskapsår holding `date` on a start month (1-12): the
 * schedule for a company with no recorded year.
 */
export function scheduledFiscalYear(date: string, startMonth: number): FiscalYearRange {
  const year = Number(date.slice(0, 4))
  const startYear = Number(date.slice(5, 7)) >= startMonth ? year : year - 1
  const start = `${startYear}-${String(startMonth).padStart(2, '0')}-01`
  return { start, end: addDays(addMonthsIso(start, 12), -1) }
}

/**
 * Suggest a fiscal period for the create dialog, given the date the user is
 * trying to book and the company's existing periods. Three cases:
 *  - No periods yet → a calendar year around the entry date.
 *  - Entry date before the earliest period → a year ending the day before it (backfill).
 *  - Entry date inside an interior gap → a year filling the hole, starting the day
 *    after the left neighbour and capped so it never overlaps the right neighbour
 *    (a clean one-year hole yields exactly that year, e.g. 2025 between 2024 and 2026).
 *  - Otherwise → the next year chaining forward off the latest period.
 */
export function computeSuggestedPeriod(
  entryDate: string,
  periods: PeriodRange[],
): SuggestedPeriod {
  if (periods.length === 0) {
    // No periods at all: suggest a calendar year period around the entry date.
    const year = entryDate.split('-')[0]
    return { name: `Räkenskapsår ${year}`, period_start: `${year}-01-01`, period_end: `${year}-12-31` }
  }

  const sorted = [...periods].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const earliest = sorted[0]
  const latest = sorted[sorted.length - 1]

  if (entryDate < earliest.period_start) {
    // Backward: end = day before earliest start, start = 12 months back, 1st of month.
    const endStr = addDays(earliest.period_start, -1)
    const start = new Date(endStr + 'T00:00:00Z')
    start.setUTCMonth(start.getUTCMonth() - 11)
    start.setUTCDate(1)
    const startStr = start.toISOString().split('T')[0]
    return { name: periodName(startStr, endStr), period_start: startStr, period_end: endStr }
  }

  // Interior gap: the entry date sits between the earliest and latest period but is
  // not contained by any existing period.
  const containing = sorted.find((p) => p.period_start <= entryDate && entryDate <= p.period_end)
  if (!containing && entryDate <= latest.period_end) {
    const leftNeighbour = [...sorted].reverse().find((p) => p.period_end < entryDate)!
    const rightNeighbour = sorted.find((p) => p.period_start > entryDate)!

    const { start: startStr, end: yearEnd } = nextFiscalYearRange(leftNeighbour.period_end)

    // Cap at the day before the right neighbour starts so we never overlap it.
    const gapEnd = addDays(rightNeighbour.period_start, -1)
    const endStr = gapEnd < yearEnd ? gapEnd : yearEnd

    return { name: periodName(startStr, endStr), period_start: startStr, period_end: endStr }
  }

  // Forward: the next year in the chain.
  const { start: startStr, end: endStr } = nextFiscalYearRange(latest.period_end)
  return { name: periodName(startStr, endStr), period_start: startStr, period_end: endStr }
}

/**
 * The räkenskapsår missing up to `entryDate`, oldest first: each chained from
 * the one before, so the last one holds the date. For a date after the first
 * recorded year and in no recorded year. `limit` caps the walk: more than that
 * many years ahead is a mistyped date, answered with an empty list.
 */
export function missingFiscalYears(
  entryDate: string,
  periods: PeriodRange[],
  limit: number,
): FiscalYearRange[] {
  const known = [...periods]
  const missing: FiscalYearRange[] = []
  while (missing.length < limit) {
    const next = computeSuggestedPeriod(entryDate, known)
    missing.push({ start: next.period_start, end: next.period_end })
    if (entryDate <= next.period_end) return missing
    known.push(next)
  }
  return []
}

/**
 * Seed date for the settings "Skapa räkenskapsår" dialog. Prefers the start of the
 * earliest gap between consecutive periods so the dialog proposes a missing year
 * (e.g. 2025 between 2024 and 2026) instead of jumping to the next forward year.
 * Falls back to the day after the latest period ends, or today when there are none.
 */
export function suggestSeedDate(periods: PeriodRange[], today: string): string {
  if (periods.length === 0) return today

  const sorted = [...periods].sort((a, b) => a.period_start.localeCompare(b.period_start))

  for (let i = 0; i < sorted.length - 1; i++) {
    const gapStart = addDays(sorted[i].period_end, 1)
    if (gapStart < sorted[i + 1].period_start) return gapStart
  }

  return addDays(sorted[sorted.length - 1].period_end, 1)
}

/**
 * Resolve which fiscal period a period-scoped view (e.g. the verifikat list)
 * should default to: the räkenskapsår the user is currently in.
 *
 * Verifikationsnummer run as an unbroken series *per räkenskapsår* (BFL 5 kap
 * 7§), so the same number (e.g. A42) legitimately recurs once per year. Showing
 * every year at once makes those look like duplicates and makes a bare "A42"
 * reference ambiguous: a period-oriented view should land on a single year.
 *
 * Resolution, given `today` (YYYY-MM-DD):
 *  1. The period that contains today.
 *  2. Else the most recent period that has already started (period_start ≤ today):
 *     covers a gap after the last year before the next one is created.
 *  3. Else the earliest period (a company whose only/first year is still upcoming).
 *  4. Else null (no periods at all → caller falls back to "all years").
 */
export function resolveCurrentPeriodId(
  periods: IdentifiablePeriod[],
  today: string,
): string | null {
  if (periods.length === 0) return null

  const containing = periods.find((p) => p.period_start <= today && today <= p.period_end)
  if (containing) return containing.id

  const started = periods
    .filter((p) => p.period_start <= today)
    .sort((a, b) => b.period_start.localeCompare(a.period_start))
  if (started.length > 0) return started[0].id

  return [...periods].sort((a, b) => a.period_start.localeCompare(b.period_start))[0].id
}
