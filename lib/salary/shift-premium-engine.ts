/**
 * Shift-premium engine — pure functions that turn worked-day shifts plus
 * configured premium rules into salary line items.
 *
 * Boundary rules:
 *   - Worked-day rows with explicit start_time/end_time use the exact window
 *     to intersect rule windows.
 *   - Worked-day rows missing one or both times fall back to a default day
 *     shift of 08:00-17:00 (`DEFAULT_SHIFT_*`). This is the legacy hours-only
 *     row shape: those days were always assumed to be plain weekday office
 *     hours, so pure-night/pure-weekend rules will not match.
 *   - Windows where end_time <= start_time are treated as wrapping past
 *     midnight (e.g. 22:00-06:00 covers 22:00-24:00 the same day and
 *     00:00-06:00 the next day). Both halves are intersected separately.
 *
 * Overlap resolution:
 *   - Multiple active rules may apply to the same minute of a shift. The
 *     engine prefers the rule with the higher `priority`; ties are broken by
 *     higher `premium_percent`. Each minute is awarded to exactly one rule,
 *     so totals never double-count.
 *
 * The engine is intentionally side-effect-free. The orchestrator
 * (run-calculation.ts) fetches the rules, runs `computePremiumLines`, and
 * persists the result as salary_line_items.
 */

import type { ShiftPremiumRule, ShiftPremiumItemType } from '@/types'
import { isSwedishHolidayISO } from '@/lib/tax/swedish-holidays'

// ============================================================
// Types
// ============================================================

export interface WorkedDayShift {
  /** ISO date (YYYY-MM-DD). */
  work_date: string
  /** Total worked hours (used as a sanity cap). */
  hours: number
  /** Optional explicit shift start ('HH:MM' or 'HH:MM:SS'). */
  start_time?: string | null
  /** Optional explicit shift end ('HH:MM' or 'HH:MM:SS'). */
  end_time?: string | null
}

export interface ShiftPremiumLineItem {
  itemType: ShiftPremiumItemType
  /** Description rendered on the payslip and verifikat. */
  description: string
  /** Date the premium applies to (the worked day). */
  workDate: string
  /** Hours actually covered by the winning rule. */
  hours: number
  /** Premium amount = baseHourlyRate × hours × premium_percent / 100. */
  amount: number
  /** Rule id used (for traceability/debugging). */
  sourceRuleId: string
}

// ============================================================
// Constants
// ============================================================

/** Total minutes in a 24h day. */
const MINUTES_PER_DAY = 24 * 60

/** Fallback shift for worked-day rows that don't carry explicit times. */
const DEFAULT_SHIFT_START_MIN = 8 * 60 // 08:00
const DEFAULT_SHIFT_END_MIN = 17 * 60 // 17:00

// ============================================================
// Helpers
// ============================================================

/** Round to 2 decimals (CLAUDE.md monetary precision rule). */
function r(x: number): number {
  return Math.round(x * 100) / 100
}

/** Parse 'HH:MM' or 'HH:MM:SS' (or 'HH:MM:SS.ffffff') to minutes-since-midnight. */
function parseTimeToMinutes(time: string): number {
  const parts = time.split(':')
  if (parts.length < 2) {
    throw new Error(`Invalid time format: ${time}`)
  }
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`Invalid time format: ${time}`)
  }
  return h * 60 + m
}

/** ISO weekday (1 = Mon … 7 = Sun) from a YYYY-MM-DD string. */
function isoWeekdayFromDate(workDate: string): number {
  // Parse as UTC to avoid the user's local timezone shifting the day.
  const [y, m, d] = workDate.split('-').map((x) => parseInt(x, 10))
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // Sun=0…Sat=6
  return day === 0 ? 7 : day
}

/** Shift a weekday by N days, staying in ISO 1..7. */
function shiftWeekday(weekday: number, offset: number): number {
  const next = ((weekday - 1 + offset) % 7 + 7) % 7
  return next + 1
}

/**
 * Resolve a shift's occupied minutes into segments keyed by ISO weekday.
 * Returns one segment per occupied weekday. Wrap-past-midnight shifts return
 * two entries.
 */
interface DaySegment {
  weekday: number
  startMin: number
  endMin: number
}

function resolveShiftSegments(shift: WorkedDayShift): DaySegment[] {
  const shiftWeekdayBase = isoWeekdayFromDate(shift.work_date)
  const hasStart = !!shift.start_time
  const hasEnd = !!shift.end_time

  if (!hasStart || !hasEnd) {
    return [
      {
        weekday: shiftWeekdayBase,
        startMin: DEFAULT_SHIFT_START_MIN,
        endMin: DEFAULT_SHIFT_END_MIN,
      },
    ]
  }

  const startMin = parseTimeToMinutes(shift.start_time!)
  const endMin = parseTimeToMinutes(shift.end_time!)

  if (endMin > startMin) {
    return [{ weekday: shiftWeekdayBase, startMin, endMin }]
  }

  // Wraps past midnight (e.g. 22:00 -> 06:00). Split at 24:00.
  return [
    { weekday: shiftWeekdayBase, startMin, endMin: MINUTES_PER_DAY },
    { weekday: shiftWeekday(shiftWeekdayBase, 1), startMin: 0, endMin },
  ]
}

/**
 * Resolve a rule's coverage windows into per-weekday segments.
 * Returns one entry per (primary weekday in rule.day_of_week × time half).
 * A rule whose end_time <= start_time wraps midnight; the second half then
 * lands on the weekday AFTER each listed primary day.
 */
function resolveRuleSegments(rule: ShiftPremiumRule): DaySegment[] {
  const startMin = parseTimeToMinutes(rule.start_time)
  const endMin = parseTimeToMinutes(rule.end_time)

  const segments: DaySegment[] = []

  for (const primaryDay of rule.day_of_week) {
    if (endMin > startMin) {
      segments.push({ weekday: primaryDay, startMin, endMin })
    } else if (startMin === endMin) {
      // 00:00-00:00 special case: full 24h coverage on the primary day only.
      segments.push({ weekday: primaryDay, startMin: 0, endMin: MINUTES_PER_DAY })
    } else {
      // Wrap past midnight.
      segments.push({ weekday: primaryDay, startMin, endMin: MINUTES_PER_DAY })
      segments.push({ weekday: shiftWeekday(primaryDay, 1), startMin: 0, endMin })
    }
  }

  return segments
}

function ruleAppliesToEmployee(rule: ShiftPremiumRule, employeeId: string): boolean {
  if (rule.applies_to_all_employees) return true
  return rule.applies_to_employee_ids.includes(employeeId)
}

/** Total dominance score (priority outweighs premium_percent). */
function ruleScore(rule: ShiftPremiumRule): number {
  return rule.priority * 1_000_000 + rule.premium_percent
}

// ============================================================
// Public API
// ============================================================

export interface ComputePremiumLinesArgs {
  employeeId: string
  baseHourlyRate: number
  workedDays: WorkedDayShift[]
  rules: ShiftPremiumRule[]
}

const DEFAULT_DESCRIPTIONS: Record<ShiftPremiumItemType, string> = {
  overtime_50: 'Övertid 50 %',
  overtime_100: 'Övertid 100 %',
  ob_weekday_evening: 'OB vardag kväll',
  ob_weekend: 'OB helg',
  ob_night: 'OB natt',
  ob_holiday: 'OB helgdag',
}

/**
 * Compute premium line items for a single employee over a set of worked days.
 *
 * Algorithm:
 *   1. Resolve each shift into per-weekday segments (one or two if wraps).
 *   2. For each segment, gather every rule-segment whose weekday matches.
 *   3. Split the segment at every rule boundary, then award each sub-interval
 *      to the single highest-scoring rule that fully covers it.
 *   4. Aggregate (work_date × rule_id) → minutes; convert to hours + amount.
 */
export function computePremiumLines(args: ComputePremiumLinesArgs): ShiftPremiumLineItem[] {
  const { employeeId, baseHourlyRate, workedDays, rules } = args
  if (baseHourlyRate <= 0 || workedDays.length === 0 || rules.length === 0) {
    return []
  }

  const applicable = rules.filter((rule) => rule.is_active && ruleAppliesToEmployee(rule, employeeId))
  if (applicable.length === 0) return []

  // Aggregate (workDate × ruleId) → minutes.
  const aggregates = new Map<
    string,
    { rule: ShiftPremiumRule; workDate: string; minutes: number }
  >()

  for (const shift of workedDays) {
    if (shift.hours <= 0) continue
    const shiftSegments = resolveShiftSegments(shift)
    // Holiday status drives ob_holiday gating. A rule with item_type === 'ob_holiday'
    // only fires when the worked day is a Swedish public holiday — day_of_week alone
    // is not enough (a regular Sunday is not a helgdag, Midsommarafton on a Tuesday is).
    const isHoliday = isSwedishHolidayISO(shift.work_date)

    for (const seg of shiftSegments) {
      // Collect rule-segments intersecting this weekday.
      const candidates: Array<{
        rule: ShiftPremiumRule
        startMin: number
        endMin: number
      }> = []
      for (const rule of applicable) {
        if (rule.item_type === 'ob_holiday' && !isHoliday) continue
        for (const ruleSeg of resolveRuleSegments(rule)) {
          if (ruleSeg.weekday !== seg.weekday) continue
          const startMin = Math.max(seg.startMin, ruleSeg.startMin)
          const endMin = Math.min(seg.endMin, ruleSeg.endMin)
          if (endMin <= startMin) continue
          candidates.push({ rule, startMin, endMin })
        }
      }
      if (candidates.length === 0) continue

      // Build boundary set inside the shift segment.
      const boundaries = new Set<number>([seg.startMin, seg.endMin])
      for (const cand of candidates) {
        boundaries.add(cand.startMin)
        boundaries.add(cand.endMin)
      }
      const sorted = [...boundaries].sort((a, b) => a - b)

      for (let i = 0; i < sorted.length - 1; i++) {
        const subStart = sorted[i]
        const subEnd = sorted[i + 1]
        if (subEnd <= subStart) continue
        if (subStart < seg.startMin || subEnd > seg.endMin) continue

        // Award this sub-interval to the highest-scoring candidate covering it.
        let winner: ShiftPremiumRule | null = null
        for (const cand of candidates) {
          if (cand.startMin > subStart || cand.endMin < subEnd) continue
          if (!winner || ruleScore(cand.rule) > ruleScore(winner)) {
            winner = cand.rule
          }
        }
        if (!winner) continue

        const minutes = subEnd - subStart
        const key = `${shift.work_date}::${winner.id}`
        const existing = aggregates.get(key)
        if (existing) {
          existing.minutes += minutes
        } else {
          aggregates.set(key, { rule: winner, workDate: shift.work_date, minutes })
        }
      }
    }
  }

  const lineItems: ShiftPremiumLineItem[] = []
  for (const agg of aggregates.values()) {
    const hours = r(agg.minutes / 60)
    if (hours <= 0) continue
    const amount = r(baseHourlyRate * hours * (agg.rule.premium_percent / 100))
    if (amount <= 0) continue
    const fallback = DEFAULT_DESCRIPTIONS[agg.rule.item_type]
    const desc = agg.rule.name
      ? `${agg.rule.name} (${agg.workDate}, ${hours} h)`
      : `${fallback} (${agg.workDate}, ${hours} h)`
    lineItems.push({
      itemType: agg.rule.item_type,
      description: desc,
      workDate: agg.workDate,
      hours,
      amount,
      sourceRuleId: agg.rule.id,
    })
  }

  lineItems.sort((a, b) => {
    if (a.workDate !== b.workDate) return a.workDate < b.workDate ? -1 : 1
    return a.itemType < b.itemType ? -1 : 1
  })

  return lineItems
}
