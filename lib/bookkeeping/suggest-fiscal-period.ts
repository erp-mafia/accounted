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

/** Minimal shape needed for the date math: `FiscalPeriod` satisfies it. */
type PeriodRange = Pick<FiscalPeriod, 'period_start' | 'period_end'>

/** A period plus its id, for resolving which räkenskapsår a view scopes to. */
type IdentifiablePeriod = Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>

export interface SuggestedPeriod {
  name: string
  period_start: string
  period_end: string
}

/** Add `days` to a YYYY-MM-DD date string, returning a YYYY-MM-DD string. */
function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}

/**
 * A fiscal-year name: `Räkenskapsår 2025`, or `Räkenskapsår 2024/2025` when it
 * straddles two calendar years. Swedish by default to match the app's existing
 * fiscal-year naming (Swedish-first); the field stays editable in the dialog.
 */
function periodName(start: string, end: string): string {
  const startYear = Number(start.slice(0, 4))
  const endYear = Number(end.slice(0, 4))
  return startYear === endYear ? `Räkenskapsår ${startYear}` : `Räkenskapsår ${startYear}/${endYear}`
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

    const startStr = addDays(leftNeighbour.period_end, 1)

    // Tentative end: 12 months after start, last day of the prior month.
    const end = new Date(startStr + 'T00:00:00Z')
    end.setUTCMonth(end.getUTCMonth() + 12)
    end.setUTCDate(0)
    let endStr = end.toISOString().split('T')[0]

    // Cap at the day before the right neighbour starts so we never overlap it.
    const gapEnd = addDays(rightNeighbour.period_start, -1)
    if (gapEnd < endStr) endStr = gapEnd

    return { name: periodName(startStr, endStr), period_start: startStr, period_end: endStr }
  }

  // Forward: start = day after latest end, end = 12 months later (last day of month).
  const startStr = addDays(latest.period_end, 1)
  const end = new Date(startStr + 'T00:00:00Z')
  end.setUTCMonth(end.getUTCMonth() + 12)
  end.setUTCDate(0)
  const endStr = end.toISOString().split('T')[0]
  return { name: periodName(startStr, endStr), period_start: startStr, period_end: endStr }
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
