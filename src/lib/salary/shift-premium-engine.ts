/**
 * Shift-premium engine: pure functions that turn worked-day shifts plus
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
 *   - Every minute is judged on the calendar date it falls on: the weekday,
 *     the public-holiday gate of ob_holiday rules and the rule's validity
 *     (valid_from, valid_to). The part of a night shift after midnight is
 *     therefore paid under the rule valid the next day, so a rate step on
 *     2026-04-01 applies from 00:00 that day. The line it lands on stays
 *     keyed by the shift's work_date.
 *
 * Amount forms (ShiftPremiumRule.amount_form, migration 20261027213119):
 *   - percent_of_hourly: hourly wage x premium_percent / 100. The hourly wage
 *     is the employee's (PremiumPayBasis.hourlyRate) unless the rule names
 *     the agreement's own hourly_divisor, which prices a monthly-paid
 *     employee's hour as full-time månadslön / hourly_divisor (Handels 166).
 *   - monthly_divisor: månadslön / monthly_divisor. Monthly-paid employees
 *     only: an hourly-paid employee has no månadslön, so the rule does not
 *     apply to them at all (a lower rule may then win their minutes; the
 *     rules service refuses to name an hourly-paid employee on such a rule).
 *     OB rules divide the actual (degree-adjusted) månadslön; övertid rules
 *     divide the full-time månadslön, because the agreements that use övertid
 *     divisors raise a part-timer's salary to full time first (Almega
 *     Tjänsteföretag 5.3.2, Teknikavtalet tjänstemän § 8 mom 3:2).
 *   - sek_per_hour: a fixed amount per hour, whatever the pay.
 *
 * Overlap resolution:
 *   - Multiple active rules may apply to the same minute of a shift. Each
 *     minute is awarded to exactly one rule, so totals never double-count:
 *     the higher `priority` wins; at equal priority the rule paying the most
 *     per hour for this employee wins (the agreements' "only the highest
 *     applies", Handels § 8 anm.); a remaining tie goes to the lower rule id
 *     so the result never depends on the order the rules were read in.
 *   - "No OB on overtime hours" (Byggavtalet § 2 p. 5, Almega 7.1, Teknik
 *     förskjuten arbetstid p. 6) is an övertid rule with a higher priority
 *     than the OB rules on the same window. Övertid itself is a window like
 *     OB: nothing here compares the worked hours with a schedule.
 *
 * The engine is intentionally side-effect-free. The orchestrator
 * (run-calculation.ts) fetches the rules, runs `computePremiumLines`, and
 * persists the result as salary_line_items with the rule's provenance
 * (source_premium_rule_id, premium_basis). The settings editor calls the same
 * function for its live example, so the two can never disagree.
 */

import type { ShiftPremiumAmountForm, ShiftPremiumItemType, ShiftPremiumRule } from '@/types'
import { isSwedishHolidayISO } from '@/lib/tax/swedish-holidays'
import { roundOre } from '@/lib/money'
import { degreeAdjustedMonthlySalary, hourlyDivisor } from './work-schedule'

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

/**
 * The pay a premium is priced from, for one employee in one run. Built by
 * `premiumPayBasis` so the calculation and the settings example agree.
 */
export interface PremiumPayBasis {
  /** The percent_of_hourly base without a rule hourly_divisor. */
  hourlyRate: number
  /**
   * Monthly-paid employees only: the run's full-time månadslön and the
   * degree-adjusted (actual) one. Absent for hourly-paid employees, which is
   * what keeps monthly_divisor rules away from them.
   */
  monthlySalary?: { fullTime: number; actual: number }
}

/** What the rate was applied to, frozen on the line (premium_basis.base). */
export type PremiumBaseKind = 'hourly_rate' | 'monthly_salary' | 'full_time_monthly_salary' | 'none'

/**
 * The rule as the calculation used it, stored on the payslip line
 * (salary_line_items.premium_basis) next to source_premium_rule_id: enough
 * to explain the amount after the rule has changed or ended.
 */
export interface PremiumBasis {
  v: 1
  rule_id: string
  rule_name: string
  item_type: ShiftPremiumItemType
  amount_form: ShiftPremiumAmountForm
  premium_percent: number | null
  monthly_divisor: number | null
  sek_per_hour: number | null
  hourly_divisor: number | null
  valid_from: string | null
  valid_to: string | null
  priority: number
  base: { kind: PremiumBaseKind; amount: number | null }
  /** Kronor per hour, to the öre (the amount itself is computed unrounded). */
  rate_per_hour: number
  work_date: string
  hours: number
}

export interface ShiftPremiumLineItem {
  itemType: ShiftPremiumItemType
  /** Description rendered on the payslip and verifikat. */
  description: string
  /** Date the premium applies to (the worked day). */
  workDate: string
  /** Hours actually covered by the winning rule. */
  hours: number
  /** Premium amount: hours x the rule's rate per hour, rounded to the öre. */
  amount: number
  /** Rule id used (salary_line_items.source_premium_rule_id). */
  sourceRuleId: string
  /** The rule as used (salary_line_items.premium_basis). */
  basis: PremiumBasis
}

// ============================================================
// Constants
// ============================================================

/** Total minutes in a 24h day. */
const MINUTES_PER_DAY = 24 * 60

/** Fallback shift for worked-day rows that don't carry explicit times. */
const DEFAULT_SHIFT_START_MIN = 8 * 60 // 08:00
const DEFAULT_SHIFT_END_MIN = 17 * 60 // 17:00

const OVERTIME_TYPES: ReadonlySet<ShiftPremiumItemType> = new Set(['overtime_50', 'overtime_100'])

// ============================================================
// Pay basis and price
// ============================================================

/**
 * The pay basis of one employee:
 *   - hourly-paid: the stored hourly_rate, no månadslön;
 *   - monthly-paid: degree-adjusted monthly salary / hourlyDivisor(hours_per_week)
 *     as the hourly wage (173 at the 40h default, the exact 52-week formula
 *     for other schedules; arbetsschema-lite), plus the full-time and the
 *     actual månadslön for the divisor forms. monthly_salary is the
 *     full-time salary and hours_per_week the part-time schedule, so the raw
 *     column over the part-time divisor would price a 10 % employee's hour
 *     ten times too high.
 */
export function premiumPayBasis(emp: {
  salary_type: 'monthly' | 'hourly'
  hourly_rate: number | null
  monthly_salary: number | null
  employment_degree: number | null
  hours_per_week?: number | null
}): PremiumPayBasis {
  if (emp.salary_type === 'hourly') return { hourlyRate: emp.hourly_rate || 0 }
  const fullTime = emp.monthly_salary || 0
  const actual = degreeAdjustedMonthlySalary(fullTime, emp.employment_degree)
  return {
    hourlyRate: actual > 0 ? roundOre(actual / hourlyDivisor(emp.hours_per_week)) : 0,
    monthlySalary: { fullTime, actual },
  }
}

export interface RulePrice {
  /** Unrounded kronor per hour: the overlap tie-break. */
  ratePerHour: number
  base: { kind: PremiumBaseKind; amount: number | null }
  /** Amount for a number of hours, rounded to the öre. */
  amountFor: (hours: number) => number
}

/**
 * The price of one hour under `rule` for this employee, or null when the
 * rule's form does not apply to the employee's pay (monthly_divisor for an
 * hourly-paid employee). The amount multiplies before it divides, in the
 * order the agreements state it (månadslön x timmar / delare), and rounds
 * once.
 */
export function priceRule(rule: ShiftPremiumRule, pay: PremiumPayBasis): RulePrice | null {
  const form: ShiftPremiumAmountForm = rule.amount_form ?? 'percent_of_hourly'
  if (form === 'sek_per_hour') {
    const sek = Number(rule.sek_per_hour ?? 0)
    return {
      ratePerHour: sek,
      base: { kind: 'none', amount: null },
      amountFor: (hours) => roundOre(sek * hours),
    }
  }
  if (form === 'monthly_divisor') {
    const divisor = Number(rule.monthly_divisor ?? 0)
    if (!pay.monthlySalary || divisor <= 0) return null
    const fullTimeBasis = OVERTIME_TYPES.has(rule.item_type)
    const salary = fullTimeBasis ? pay.monthlySalary.fullTime : pay.monthlySalary.actual
    return {
      ratePerHour: salary / divisor,
      base: { kind: fullTimeBasis ? 'full_time_monthly_salary' : 'monthly_salary', amount: salary },
      amountFor: (hours) => roundOre((salary * hours) / divisor),
    }
  }
  const percent = Number(rule.premium_percent ?? 0)
  const agreementDivisor = rule.hourly_divisor == null ? 0 : Number(rule.hourly_divisor)
  if (agreementDivisor > 0 && pay.monthlySalary) {
    const salary = pay.monthlySalary.fullTime
    return {
      ratePerHour: (salary / agreementDivisor) * (percent / 100),
      base: { kind: 'full_time_monthly_salary', amount: salary },
      amountFor: (hours) => roundOre(((salary * hours) / agreementDivisor) * (percent / 100)),
    }
  }
  const hourly = pay.hourlyRate
  return {
    ratePerHour: hourly * (percent / 100),
    base: { kind: 'hourly_rate', amount: hourly },
    amountFor: (hours) => roundOre(hourly * hours * (percent / 100)),
  }
}

// ============================================================
// Helpers
// ============================================================

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
export function isoWeekdayFromDate(workDate: string): number {
  // Parse as UTC to avoid the user's local timezone shifting the day.
  const [y, m, d] = workDate.split('-').map((x) => parseInt(x, 10))
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // Sun=0…Sat=6
  return day === 0 ? 7 : day
}

/** The ISO date one day after `isoDate`, in UTC. */
export function nextIsoDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map((x) => parseInt(x, 10))
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
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

interface ShiftSegment extends DaySegment {
  /** The calendar date the minutes fall on. */
  date: string
}

function resolveShiftSegments(shift: WorkedDayShift): ShiftSegment[] {
  const shiftWeekdayBase = isoWeekdayFromDate(shift.work_date)
  const hasStart = !!shift.start_time
  const hasEnd = !!shift.end_time

  if (!hasStart || !hasEnd) {
    return [
      {
        weekday: shiftWeekdayBase,
        date: shift.work_date,
        startMin: DEFAULT_SHIFT_START_MIN,
        endMin: DEFAULT_SHIFT_END_MIN,
      },
    ]
  }

  const startMin = parseTimeToMinutes(shift.start_time!)
  const endMin = parseTimeToMinutes(shift.end_time!)

  if (endMin > startMin) {
    return [{ weekday: shiftWeekdayBase, date: shift.work_date, startMin, endMin }]
  }

  // Wraps past midnight (e.g. 22:00 -> 06:00). Split at 24:00.
  return [
    { weekday: shiftWeekdayBase, date: shift.work_date, startMin, endMin: MINUTES_PER_DAY },
    { weekday: shiftWeekday(shiftWeekdayBase, 1), date: nextIsoDate(shift.work_date), startMin: 0, endMin },
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

/** True when the rule is valid on `isoDate` (both bounds inclusive, null = open). */
export function ruleValidOn(rule: Pick<ShiftPremiumRule, 'valid_from' | 'valid_to'>, isoDate: string): boolean {
  if (rule.valid_from && isoDate < rule.valid_from.slice(0, 10)) return false
  if (rule.valid_to && isoDate > rule.valid_to.slice(0, 10)) return false
  return true
}

interface PricedRule {
  rule: ShiftPremiumRule
  price: RulePrice
  segments: DaySegment[]
}

/** Priority first, then the rate per hour, then the lower id. */
function beats(a: PricedRule, b: PricedRule): boolean {
  if (a.rule.priority !== b.rule.priority) return a.rule.priority > b.rule.priority
  if (a.price.ratePerHour !== b.price.ratePerHour) return a.price.ratePerHour > b.price.ratePerHour
  return a.rule.id < b.rule.id
}

// ============================================================
// Public API
// ============================================================

export interface ComputePremiumLinesArgs {
  employeeId: string
  /** The percent_of_hourly base (PremiumPayBasis.hourlyRate). */
  baseHourlyRate: number
  /**
   * Monthly-paid employees: the full-time and actual månadslön
   * (PremiumPayBasis.monthlySalary). Omitted for hourly-paid employees.
   */
  monthlySalary?: { fullTime: number; actual: number } | null
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
 *   1. Price every applicable rule once for this employee.
 *   2. Resolve each shift into per-date segments (one or two if it wraps).
 *   3. For each segment, gather every rule-segment whose weekday matches and
 *      whose rule is valid (and, for ob_holiday, a holiday) on that date.
 *   4. Split the segment at every rule boundary, then award each sub-interval
 *      to the single winning rule that fully covers it.
 *   5. Aggregate (work_date × rule_id) → minutes; convert to hours + amount.
 */
export function computePremiumLines(args: ComputePremiumLinesArgs): ShiftPremiumLineItem[] {
  const { employeeId, workedDays, rules } = args
  if (workedDays.length === 0 || rules.length === 0) {
    return []
  }
  const pay: PremiumPayBasis = {
    hourlyRate: args.baseHourlyRate,
    ...(args.monthlySalary ? { monthlySalary: args.monthlySalary } : {}),
  }

  const priced: PricedRule[] = []
  for (const rule of rules) {
    if (!rule.is_active || !ruleAppliesToEmployee(rule, employeeId)) continue
    const price = priceRule(rule, pay)
    if (!price) continue
    priced.push({ rule, price, segments: resolveRuleSegments(rule) })
  }
  if (priced.length === 0) return []

  // Aggregate (workDate × ruleId) → minutes.
  const aggregates = new Map<string, { candidate: PricedRule; workDate: string; minutes: number }>()

  for (const shift of workedDays) {
    if (shift.hours <= 0) continue

    for (const seg of resolveShiftSegments(shift)) {
      // ob_holiday rules fire only on a Swedish public holiday: day_of_week
      // alone is not enough (a regular Sunday is not a helgdag, Midsommarafton
      // on a Friday is). Judged on the date the minutes fall on.
      const isHoliday = isSwedishHolidayISO(seg.date)
      const candidates: Array<{ candidate: PricedRule; startMin: number; endMin: number }> = []
      for (const candidate of priced) {
        const { rule } = candidate
        if (rule.item_type === 'ob_holiday' && !isHoliday) continue
        if (!ruleValidOn(rule, seg.date)) continue
        for (const ruleSeg of candidate.segments) {
          if (ruleSeg.weekday !== seg.weekday) continue
          const startMin = Math.max(seg.startMin, ruleSeg.startMin)
          const endMin = Math.min(seg.endMin, ruleSeg.endMin)
          if (endMin <= startMin) continue
          candidates.push({ candidate, startMin, endMin })
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

        // Award this sub-interval to the winning candidate covering it.
        let winner: PricedRule | null = null
        for (const cand of candidates) {
          if (cand.startMin > subStart || cand.endMin < subEnd) continue
          if (!winner || beats(cand.candidate, winner)) {
            winner = cand.candidate
          }
        }
        if (!winner) continue

        const minutes = subEnd - subStart
        const key = `${shift.work_date}::${winner.rule.id}`
        const existing = aggregates.get(key)
        if (existing) {
          existing.minutes += minutes
        } else {
          aggregates.set(key, { candidate: winner, workDate: shift.work_date, minutes })
        }
      }
    }
  }

  const lineItems: ShiftPremiumLineItem[] = []
  for (const agg of aggregates.values()) {
    const hours = roundOre(agg.minutes / 60)
    if (hours <= 0) continue
    const { rule, price } = agg.candidate
    const amount = price.amountFor(hours)
    if (amount <= 0) continue
    const fallback = DEFAULT_DESCRIPTIONS[rule.item_type]
    const desc = rule.name
      ? `${rule.name} (${agg.workDate}, ${hours} h)`
      : `${fallback} (${agg.workDate}, ${hours} h)`
    lineItems.push({
      itemType: rule.item_type,
      description: desc,
      workDate: agg.workDate,
      hours,
      amount,
      sourceRuleId: rule.id,
      basis: {
        v: 1,
        rule_id: rule.id,
        rule_name: rule.name,
        item_type: rule.item_type,
        amount_form: rule.amount_form ?? 'percent_of_hourly',
        premium_percent: rule.premium_percent == null ? null : Number(rule.premium_percent),
        monthly_divisor: rule.monthly_divisor == null ? null : Number(rule.monthly_divisor),
        sek_per_hour: rule.sek_per_hour == null ? null : Number(rule.sek_per_hour),
        hourly_divisor: rule.hourly_divisor == null ? null : Number(rule.hourly_divisor),
        valid_from: rule.valid_from ?? null,
        valid_to: rule.valid_to ?? null,
        priority: rule.priority,
        base: price.base,
        rate_per_hour: roundOre(price.ratePerHour),
        work_date: agg.workDate,
        hours,
      },
    })
  }

  lineItems.sort((a, b) => {
    if (a.workDate !== b.workDate) return a.workDate < b.workDate ? -1 : 1
    if (a.itemType !== b.itemType) return a.itemType < b.itemType ? -1 : 1
    return a.sourceRuleId < b.sourceRuleId ? -1 : a.sourceRuleId > b.sourceRuleId ? 1 : 0
  })

  return lineItems
}
