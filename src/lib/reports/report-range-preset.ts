import { isSaneDateString } from '@/lib/invariants/iso-date'
import { windowFitsPeriod, type DrilldownWindow } from '@/lib/reports/report-drilldown'

/**
 * The period picker's presets (components/common/ReportDateRange.tsx) and the
 * choice it remembers per company in localStorage.
 *
 * A remembered choice must be enough on its own to rebuild the window the
 * user picked: the picker remounts on every route change (a drill-down into
 * the huvudbok and back), and its parent starts again from an empty range,
 * which the reports read as the whole fiscal year. A preset rebuilds from its
 * name; a custom range only from its dates, so those are stored with it.
 */

export type RangePreset = 'full_year' | 'ytd' | 'this_month' | 'last_month' | 'this_quarter' | 'custom'

export const RANGE_PRESETS: readonly RangePreset[] = [
  'full_year',
  'ytd',
  'this_month',
  'last_month',
  'this_quarter',
  'custom',
]

/** What is written to localStorage: a preset name, or a custom range with both bounds. */
export type StoredRangeChoice =
  | { preset: Exclude<RangePreset, 'custom'> }
  | { preset: 'custom'; fromDate: string; toDate: string }

export function clampToPeriod(date: string, periodStart: string, periodEnd: string): string {
  if (date < periodStart) return periodStart
  if (date > periodEnd) return periodEnd
  return date
}

/**
 * Resolve a preset to a concrete range inside the fiscal period.
 *
 * Endpoints are always clamped to the period: e.g. "this month" outside the
 * period collapses to a zero-width range at whichever boundary you're nearest.
 * `full_year` returns `{}` so the API call omits the params entirely and the
 * report falls back to its full-period default (preserves cache parity with
 * the pre-feature behaviour). `custom` has no dates of its own and also
 * returns `{}`; a stored custom range is rebuilt by {@link restoreRangeChoice}.
 */
export function resolvePreset(
  preset: RangePreset,
  periodStart: string,
  periodEnd: string,
  reference: string,
): DrilldownWindow {
  if (preset === 'full_year') return {}
  if (preset === 'custom') return {}
  if (preset === 'ytd') {
    const to = clampToPeriod(reference, periodStart, periodEnd)
    return { fromDate: periodStart, toDate: to }
  }
  const ref = new Date(reference)
  // Same UTC pitfall as the picker's todayIso(): Date.toISOString() returns
  // UTC, so a local Date constructed via `new Date(y, m, d)` round-trips to
  // the wrong calendar day in any timezone west of UTC. Use the local
  // components.
  const toLocalIso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (preset === 'this_month') {
    const y = ref.getFullYear()
    const m = ref.getMonth()
    const start = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const end = toLocalIso(new Date(y, m + 1, 0))
    return {
      fromDate: clampToPeriod(start, periodStart, periodEnd),
      toDate: clampToPeriod(end, periodStart, periodEnd),
    }
  }
  if (preset === 'last_month') {
    const y = ref.getFullYear()
    const m = ref.getMonth() - 1
    const start = toLocalIso(new Date(y, m, 1))
    const end = toLocalIso(new Date(y, m + 1, 0))
    return {
      fromDate: clampToPeriod(start, periodStart, periodEnd),
      toDate: clampToPeriod(end, periodStart, periodEnd),
    }
  }
  if (preset === 'this_quarter') {
    const y = ref.getFullYear()
    const q = Math.floor(ref.getMonth() / 3)
    const start = `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`
    const end = toLocalIso(new Date(y, q * 3 + 3, 0))
    return {
      fromDate: clampToPeriod(start, periodStart, periodEnd),
      toDate: clampToPeriod(end, periodStart, periodEnd),
    }
  }
  return {}
}

export function serializeRangeChoice(choice: StoredRangeChoice): string {
  return JSON.stringify(
    choice.preset === 'custom'
      ? { preset: 'custom', fromDate: choice.fromDate, toDate: choice.toDate }
      : { preset: choice.preset },
  )
}

function isRangePreset(value: unknown): value is RangePreset {
  return typeof value === 'string' && (RANGE_PRESETS as readonly string[]).includes(value)
}

/**
 * Read back what {@link serializeRangeChoice} wrote. Values stored before the
 * custom dates were kept are a bare preset name (`'ytd'`); those still read.
 * Anything else (unparseable, an unknown preset, a custom range without two
 * real dates, including the bare `'custom'` older builds wrote) is `null`.
 */
export function parseStoredRangeChoice(raw: string | null): StoredRangeChoice | null {
  if (!raw) return null
  let parsed: unknown = raw
  if (raw.startsWith('{')) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof parsed === 'string') {
    return isRangePreset(parsed) && parsed !== 'custom' ? { preset: parsed } : null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { preset, fromDate, toDate } = parsed as Record<string, unknown>
  if (!isRangePreset(preset)) return null
  if (preset !== 'custom') return { preset }
  if (typeof fromDate !== 'string' || typeof toDate !== 'string') return null
  if (!isSaneDateString(fromDate) || !isSaneDateString(toDate)) return null
  return { preset: 'custom', fromDate, toDate }
}

/**
 * The preset to show and the window to apply when the picker mounts or the
 * fiscal period changes. A stored custom range is applied only when it lies
 * inside the current period; one from another fiscal year, or any stored
 * value that does not parse, falls back to `defaultPreset`.
 */
export function restoreRangeChoice(
  raw: string | null,
  context: { periodStart: string; periodEnd: string; defaultPreset: RangePreset; today: string },
): { preset: RangePreset; value: DrilldownWindow } {
  const { periodStart, periodEnd, defaultPreset, today } = context
  const stored = parseStoredRangeChoice(raw)
  if (stored?.preset === 'custom') {
    const range = { fromDate: stored.fromDate, toDate: stored.toDate }
    if (windowFitsPeriod(range, periodStart, periodEnd)) return { preset: 'custom', value: range }
  } else if (stored) {
    return { preset: stored.preset, value: resolvePreset(stored.preset, periodStart, periodEnd, today) }
  }
  return { preset: defaultPreset, value: resolvePreset(defaultPreset, periodStart, periodEnd, today) }
}
