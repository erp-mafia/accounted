import type { SupabaseClient } from '@supabase/supabase-js'
import type { PayrollConfig } from './payroll-config'
import { daysBetweenIso } from '@/lib/dates/iso'
import type { SalaryCalculationPolicy } from './calculation-policy'
import { calendarLeaveDeduction } from './calendar-leave'
import { payslipLineFlags, type PayslipLineFlags } from './line-item-roles'
import { scheduledHoursPerDay } from './work-schedule'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isSwedishHolidayISO } from '@/lib/tax/swedish-holidays'
import { CALENDAR_PRICED_ABSENCE_TYPES, FRANVARO_ABSENCE_TYPES } from './late-days'

/**
 * Derive payroll line items from per-day absence records.
 *
 * Sjuklöneperiod boundaries, återinsjuknande and högriskskydd depend on
 * actual dates, which live in `salary_absence_days`. This module walks the
 * per-day records and emits correctly-classified line items.
 *
 * Swedish payroll rules implemented:
 *   - **Sjuklöneperiod** (Sjuklönelagen) = first sick day → calendar-day 14
 *     (counted over the sick spells only, see "Which days count" below).
 *     Days 1-14 are sjuklön at 80 % of the lost pay (SjLL 6 §), less ONE
 *     karensavdrag per period of 20 % of an average week's sjuklön (SjLL
 *     6 § since 2019, replacing the old karensdag). The karensavdrag can
 *     never exceed the sjuklön the period actually yields, so a short first
 *     day carries the rest of it into the next sick day, also across a
 *     month boundary. Day 15+ is Försäkringskassan; employer pays nothing
 *     but must report.
 *   - **Partial days**: a row's hours against the scheduled hours per day
 *     weight the deduction (4 h of an 8 h day = half a day); the reported
 *     day counts stay whole days because AGI reports dates, not hours.
 *   - **Återinsjuknande**: if the next sick day is within 5 calendar days of
 *     the previous sjuklöneperiod's last day, both merge: no new karens. On
 *     a sparse schedule the window grows to the widest gap between two
 *     scheduled days (sjukloneperiodGapTolerance), since sick rows exist
 *     only on scheduled days.
 *   - **Which days count toward the 14** (SjLL 7 §): the new sick period
 *     after an återinsjuknande covers only as many calendar days as, with
 *     the earlier sjuklöneperiod, make fourteen. The days the employee was
 *     back at work in between do not count. A sjuklöneperiod is therefore
 *     numbered per sick spell (sjukperiod): within a spell every calendar
 *     day counts (a weekend between two sick weekdays of one illness is
 *     sick days 6 and 7, as before), and a later spell starts where the
 *     earlier ones left off (sjukloneperiodDayIndex). Sick rows exist only
 *     on scheduled days, so a gap between two sick rows ends a spell when
 *     it holds at least one scheduled working day without a sick row: the
 *     employee was back (backAtWorkBetween). Limits: the five-day week is
 *     read as Monday to Friday less Swedish public holidays, the schedule
 *     the rest of the salary module assumes; any other schedule has no
 *     weekdays on record, so a gap ends a spell only when it is wider than
 *     two consecutive scheduled days can be apart (8 - workdays per week),
 *     which below four days a week never happens inside one sjuklöneperiod
 *     (those keep counting calendar days, as before). And a spell ends on
 *     its last sick row: non-scheduled days after it (the weekend before
 *     the employee came back) have no row saying they were sick and do
 *     not count.
 *   - **Allmänt högriskskydd**: max 10 karensavdrag per rolling 12-month
 *     window (inclusive of the new one). The 11th is suppressed.
 *
 * For VAB and parental leave, days are aggregated within the pay period and
 * priced by calculateVabDeduction / calculateParentalLeaveDeduction below.
 * The 120-date semestergrundande cap (SemL 17 a § första stycket 1 for VAB,
 * 3 for parental leave) is applied per date: when the 120th date falls inside
 * the period, the dates up to and including it form one row that is
 * semestergrundande and the dates after it a second row that is not.
 *
 * Semesterlönegrundande frånvaro and the procentregeln base (SemL 16 b §
 * andra and tredje stycket): the pay for a day of semesterlönegrundande
 * absence (17-17 b §§) is left out of the base, which instead gets the income
 * the employee would have had working that day. Absence that is not
 * semesterlönegrundande is pay never earned, so it lowers the base.
 * is_vacation_basis on a row says whether its amount enters the base:
 *   - a deduction for qualifying absence (sick days, VAB and parental leave
 *     within the cap) is false: a monthly salary already holds the pay the
 *     employee would have had, so the base stays whole;
 *   - a deduction for absence that does not qualify (unpaid leave, VAB or
 *     parental leave past the cap) is true: the base drops with the pay;
 *   - hourly pay's positive sjuklön row is false: sick pay is the pay for a
 *     qualifying day, and timlön never held the hours, so the base gets the
 *     hours the employee would have worked at timlön instead
 *     (DeriveResult.qualifyingAbsenceHours, priced by the engine).
 * Sick days count as qualifying throughout: the 180-day cap of 17 § is not
 * tracked (it counts calendar days of the whole absence, including days the
 * employee would not have worked, and arbetsskada has no cap).
 *
 * Hourly pay (salaryType 'hourly') has no full salary to deduct from: the
 * hours a sick employee would have worked were never in base pay, which is
 * rate × worked hours. So the same sjuklöneperioder, karens carry and
 * högriskskydd apply, but days 1-14 are PAID as a positive sjuklön row of 80 %
 * of timlön × the hours on each sick row (the hours the employee was
 * scheduled to work, SjLL 6 § 1 st), and the karensavdrag is 20 % of a week's
 * sjuklön at timlön × the employee's weekly hours (SjLL 6 § 2 st). Day 15+
 * and the other leave types deduct nothing: there is nothing to take back.
 *
 * Company conventions (lib/salary/calculation-policy.ts) change HOW a day is
 * priced, never WHICH days are sjuklön, karens or Försäkringskassan:
 * sick_rate = annual_hourly prices sick days 1-14 per hour at månadslön × 12
 * / (52 × veckoarbetstid); long_leave = calendar_after_five_workdays prices
 * parental leave, unpaid leave and sick day 15+ per calendar day once an
 * episode exceeds five working days (lib/salary/calendar-leave.ts).
 */

export type AbsenceType =
  | 'sick'
  | 'vab'
  | 'parental'
  | 'pregnancy'
  | 'care_relative'
  | 'study'
  | 'unpaid_leave'
  | 'other_leave'

export interface AbsenceDay {
  absence_date: string // YYYY-MM-DD
  absence_type: AbsenceType
  hours: number
}

export interface DerivedLineItem extends PayslipLineFlags {
  item_type: 'sick_karens' | 'sick_day2_14' | 'sick_day15_plus' | 'vab' | 'parental_leave' | 'unpaid_leave'
  description: string
  quantity: number
  amount: number
}

export interface AggregatedCounts {
  sickDays: number
  vabDays: number
  parentalDays: number
  unpaidLeaveDays: number
}

export interface DeriveResult {
  lineItems: DerivedLineItem[]
  aggregated: AggregatedCounts
  /** At least one sick day in the pay period fell on segment day 15+ (Försäkringskassan reporting required). */
  flagFkReporting: boolean
  /** At least one segment passed day 8 in the period (läkarintyg expected). */
  flagLakarintyg: boolean
  /**
   * Hourly pay only (0 otherwise): the hours of semesterlönegrundande absence
   * in the period, i.e. the hours the employee would have worked on the sick
   * days and on the VAB and parental days within the cap. The procentregeln
   * and semesterersättning base adds timlön × these hours (SemL 16 b § tredje
   * stycket). A monthly salary already holds that pay.
   */
  qualifyingAbsenceHours: number
}

/** One sick spell (sjukperiod) inside a sjuklöneperiod: first to last sick row, no working day in between. */
export interface SickSpell {
  startDate: string
  endDate: string
}

interface SjukloneperiodSegment {
  startDate: string
  endDate: string
  /** Number of *sick days* in this merged segment (not calendar days). */
  sickDayCount: number
  /**
   * The sick spells the sjuklöneperiod is made of, in date order: one, or
   * more when an återinsjuknande continued it after the employee was back
   * at work. Their calendar days are what counts toward the fourteen.
   */
  spells: SickSpell[]
  /** True if this segment is the continuation of a prior segment via
   *  återinsjuknande (gap within sjukloneperiodGapTolerance). No new
   *  karensavdrag. */
  isAterinsjuknande: boolean
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/** SemL 17 a § första stycket: calendar dates that stay semesterlönegrundande,
 *  per intjänandeår for VAB (1) and per child for parental leave (3), the
 *  latter counted per intjänandeår here (best effort: no child identity).
 *  The 180 dates of an ensamstående förälder are not modelled. */
const VACATION_BASIS_CAP_DATES = 120

interface VacationBasisPart {
  rows: AbsenceDay[]
  qualifies: boolean
}

/**
 * Split a period's VAB or parental rows at the 120-date cap. The cap counts
 * whole dates, not weighted hours, and the YTD figure is a date count too:
 * walking the rows in date order, the ones whose position (YTD + index) is
 * at most 120 are semestergrundande, the rest are not. Returns only the
 * non-empty parts, qualifying first, so a period that lies entirely on one
 * side of the cap still yields a single row.
 */
function splitAtVacationBasisCap(rows: AbsenceDay[], daysYtd: number): VacationBasisPart[] {
  const sorted = [...rows].sort((a, b) =>
    a.absence_date < b.absence_date ? -1 : a.absence_date > b.absence_date ? 1 : 0,
  )
  const room = Math.max(0, VACATION_BASIS_CAP_DATES - daysYtd)
  const parts: VacationBasisPart[] = [
    { rows: sorted.slice(0, room), qualifies: true },
    { rows: sorted.slice(room), qualifies: false },
  ]
  return parts.filter(p => p.rows.length > 0)
}

function dateOnly(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

function addDays(d: string, n: number): string {
  const t = new Date(dateOnly(d).getTime() + n * ONE_DAY_MS)
  return t.toISOString().slice(0, 10)
}

/**
 * Calendar days two sick rows may lie apart and still be one sjuklöneperiod.
 *
 * The law's floor is the återinsjuknande rule (SjLL 7 §: sick again within
 * 5 calendar days continues the period). Sick rows exist only on SCHEDULED
 * days, so for a sparse schedule the rows of one continuous illness are
 * further apart than that: an employee who works one day a week and is
 * sick for a month has rows 7 days apart. A gap can only mean "was well and
 * worked in between" if it holds a scheduled day with no sick row, and with
 * w working days spread over the week the widest gap between two consecutive
 * scheduled days is 8 - w (1 d/w: 7, 2 d/w: 6, 3 d/w or more: 5, the floor).
 * Issue #2876.
 */
export function sjukloneperiodGapTolerance(workdaysPerWeek: number | null | undefined): number {
  const w = Number(workdaysPerWeek) > 0 ? Math.min(7, Math.floor(Number(workdaysPerWeek))) : 5
  return Math.max(5, 8 - w)
}

/** Whole days per week of a schedule, 1 to 7; a missing or nonsense value is the five-day week. */
function workdaysOf(workdaysPerWeek: number | null | undefined): number {
  return Number(workdaysPerWeek) > 0 ? Math.min(7, Math.floor(Number(workdaysPerWeek))) : 5
}

/**
 * Whether the employee was back at work between two sick rows of one
 * sjuklöneperiod: the gap holds at least one scheduled working day without a
 * sick row (sick rows exist only on scheduled days). A five-day week is
 * Monday to Friday less Swedish public holidays, the schedule the rest of
 * the salary module assumes (absence.ts, calendar-leave.ts). Any other
 * schedule has no weekdays on record, so the gap proves a working day only
 * when it is wider than two consecutive scheduled days can be apart (8 - w
 * calendar days, as in sjukloneperiodGapTolerance).
 */
export function backAtWorkBetween(previousSickDate: string, nextSickDate: string, workdaysPerWeek?: number | null): boolean {
  const gap = daysBetweenIso(previousSickDate, nextSickDate)
  if (gap <= 1) return false
  const w = workdaysOf(workdaysPerWeek)
  if (w !== 5) return gap > 8 - w
  for (let i = 1; i < gap; i++) {
    const date = addDays(previousSickDate, i)
    const weekday = dateOnly(date).getUTCDay()
    if (weekday !== 0 && weekday !== 6 && !isSwedishHolidayISO(date)) return true
  }
  return false
}

/**
 * The day of its sjuklöneperiod a sick date is (1-based): the calendar days
 * of the earlier spells, then the calendar days of its own spell up to the
 * date (SjLL 7 §: the continued period covers only what is left of the
 * fourteen). Days 1-14 are sjuklön, 15 and later Försäkringskassan. A date
 * between two spells (no sick row there) counts as the first day after the
 * earlier spells.
 */
export function sjukloneperiodDayIndex(seg: Pick<SjukloneperiodSegment, 'spells'>, date: string): number {
  let used = 0
  for (const spell of seg.spells) {
    if (date < spell.startDate) break
    if (date <= spell.endDate) return used + daysBetweenIso(spell.startDate, date) + 1
    used += daysBetweenIso(spell.startDate, spell.endDate) + 1
  }
  return used + 1
}

/**
 * Walk the (sorted ascending) sick dates and merge them into sjuklöneperioder
 * using the SjLL återinsjuknande rule: a gap of 1 to `tolerance` calendar
 * days = same period continues; a wider gap = new period. The tolerance is
 * 5 at a five-day week and grows for sparser schedules, see
 * sjukloneperiodGapTolerance. Inside a period, a gap the employee spent back
 * at work (backAtWorkBetween) starts a new sick spell of the same period.
 */
export function buildSjukloneperioder(
  sickDates: string[],
  workdaysPerWeek?: number | null,
): SjukloneperiodSegment[] {
  if (sickDates.length === 0) return []
  const tolerance = sjukloneperiodGapTolerance(workdaysPerWeek)
  const sorted = [...new Set(sickDates)].sort()

  const segments: SjukloneperiodSegment[] = []
  let startDate = sorted[0]
  let endDate = sorted[0]
  let count = 1
  let spellStart = sorted[0]
  let spells: SickSpell[] = []

  const flush = () => {
    spells.push({ startDate: spellStart, endDate })
    segments.push({
      startDate,
      endDate,
      sickDayCount: count,
      spells,
      // The *first* segment is never återinsjuknande (no prior period).
      // For subsequent segments, this flag is set below when starting a new one.
      isAterinsjuknande: false,
    })
  }

  for (let i = 1; i < sorted.length; i++) {
    const date = sorted[i]
    const gap = daysBetweenIso(endDate, date)
    if (gap === 0) continue
    if (gap >= 1 && gap <= tolerance) {
      // Within the tolerance: same period (contiguous OR återinsjuknande).
      // Back at work in between: the earlier spell ended, a new one begins.
      if (backAtWorkBetween(endDate, date, workdaysPerWeek)) {
        spells.push({ startDate: spellStart, endDate })
        spellStart = date
      }
      endDate = date
      count += 1
      continue
    }
    // gap > tolerance: close current segment, start new one
    flush()
    startDate = date
    endDate = date
    count = 1
    spellStart = date
    spells = []
  }
  flush()

  // Annotate isAterinsjuknande based on inter-segment gap (only meaningful if
  // the gap from prior segment's end to this segment's start is 1-5 days,
  // which the merge logic above already excludes: so this stays false. The
  // återinsjuknande logic is fully captured by the merge above; we keep the
  // flag for caller introspection if they pass in pre-segmented data.)
  return segments
}

export interface AbsenceStep {
  label: string
  formula: string
  input: Record<string, number | string>
  output: number
}

/**
 * Calculate VAB (vård av barn) deduction.
 * Full daily rate deduction: Försäkringskassan compensates the parent.
 * Semesterlönegrundande for the first 120 days of the intjänandeår (180 for
 * an ensamstående förälder) per SemL 17 a § första stycket 1.
 */
export function calculateVabDeduction(
  monthlySalary: number,
  vabDays: number,
  totalVabDaysThisYear: number = 0,
  dailyDivisor: number = 21
): { deduction: number; semesterGrundande: boolean; steps: AbsenceStep[] } {
  const r = (x: number) => Math.round(x * 100) / 100
  const dailyRate = r(monthlySalary / dailyDivisor)
  const deduction = r(dailyRate * vabDays)
  const semesterGrundande = totalVabDaysThisYear + vabDays <= 120

  return {
    deduction,
    semesterGrundande,
    steps: [{
      label: 'VAB-avdrag',
      formula: 'dagslön × vab_dagar',
      input: { daily_rate: dailyRate, vab_days: vabDays, ytd_days: totalVabDaysThisYear },
      output: deduction,
    }],
  }
}

/**
 * Calculate parental leave deduction.
 * Semesterlönegrundande for the first 120 days per child per SemL 17 a §
 * första stycket 3.
 */
export function calculateParentalLeaveDeduction(
  monthlySalary: number,
  parentalDays: number,
  totalParentalDaysThisPregnancy: number = 0,
  dailyDivisor: number = 21
): { deduction: number; semesterGrundande: boolean; steps: AbsenceStep[] } {
  const r = (x: number) => Math.round(x * 100) / 100
  const dailyRate = r(monthlySalary / dailyDivisor)
  const deduction = r(dailyRate * parentalDays)
  const semesterGrundande = totalParentalDaysThisPregnancy + parentalDays <= 120

  return {
    deduction,
    semesterGrundande,
    steps: [{
      label: 'Föräldraledigavdrag',
      formula: 'dagslön × föräldradagar',
      input: { daily_rate: dailyRate, parental_days: parentalDays },
      output: deduction,
    }],
  }
}

/**
 * An input the derivation cannot price without, named in Swedish for the
 * person running payroll. run-calculation refuses the run with it rather
 * than pay sick leave as 0 kr.
 */
export class AbsenceInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbsenceInputError'
  }
}

export interface DeriveInput {
  /** The pay absence is deducted from (monthly pay only; 0 for hourly pay). */
  monthlySalary: number
  /** employees.salary_type. Omitted = 'monthly'. See the module comment for
   *  how hourly sick pay differs. */
  salaryType?: 'monthly' | 'hourly'
  /** employees.hourly_rate. Required when salaryType is 'hourly' and the
   *  period has sick rows. */
  hourlyRate?: number | null
  payrollConfig: PayrollConfig
  /** Absence rows in the pay period being calculated. */
  periodDays: AbsenceDay[]
  /** All sick dates in the prior 12 months (excluding the period). Needed
   *  to merge segments across pay periods (a period that started in the
   *  previous month already consumed some of the 14-day window) and to
   *  count karensavdrag for högriskskydd. */
  lookbackSickDates: string[]
  /** The same lookback rows with their hours, when known. A karensavdrag
   *  that a short first day could not absorb continues on the next sick
   *  day, so a period straddling a month boundary needs the prior hours to
   *  know how much is left. Absent (older callers): every lookback day is
   *  taken as a full scheduled day. */
  lookbackSickDays?: AbsenceDay[]
  /** Scheduled hours per working day (hours_per_week / workdays_per_week).
   *  Omitted: scheduledHoursPerDay of hoursPerWeek and workdaysPerWeek. Absence
   *  hours above it count as one full day. */
  hoursPerDay?: number
  /** VAB dates in the intjänandeår before the current period. */
  vabDaysYtd: number
  /** Parental leave dates per child before the current period (best effort:
   *  the intjänandeår's dates, as no child identity is recorded). */
  parentalDaysPregnancyYtd: number
  /** Cutover state (payroll gap-closure 2.2): karens periods in the 12
   *  months before cutover NOT represented by imported salary_absence_days
   *  rows. Added to the högriskskydd window count so a mid-year switcher's
   *  cap position carries over. The caller zeroes this once the lookback
   *  window no longer overlaps pre-cutover time. */
  karensPeriodsAdjustment?: number
  /** Work-schedule daily-rate divisor (arbetsschema-lite). Defaults to the
   *  legacy 21 (5-day week); part-time schedules pass
   *  dailyDivisor(workdays_per_week) from lib/salary/work-schedule. */
  dailyDivisor?: number
  /** Scheduled hours per week (employment-degree adjusted). Read under
   *  sick_rate = annual_hourly and, for hourly pay, as the average week the
   *  karensavdrag is taken from; defaults to hoursPerDay × 5. */
  hoursPerWeek?: number
  /** Working days per week. long_leave = calendar_after_five_workdays is a
   *  five-day-week rule and refuses any other schedule. */
  workdaysPerWeek?: number
  /** Company calculation conventions (lib/salary/calculation-policy.ts).
   *  Omitted = every default = the historical derivation. */
  calculationPolicy?: SalaryCalculationPolicy
  /** Deviation window the periodDays were read from. Required under
   *  long_leave = calendar_after_five_workdays (the calendar rate covers the
   *  in-window part of an episode only). */
  periodStart?: string
  periodEnd?: string
  /** Registered absence rows OUTSIDE the window (the surrounding month on
   *  each side). They decide whether an episode is longer than five working
   *  days; they are never deducted here. Only read under the calendar
   *  convention; leave_context = through_deviation_end drops the rows after
   *  periodEnd. */
  contextDays?: AbsenceDay[]
}

export function deriveAbsenceLineItems(input: DeriveInput): DeriveResult {
  const { monthlySalary, payrollConfig, periodDays } = input
  const lineItems: DerivedLineItem[] = []
  const r = (x: number) => Math.round(x * 100) / 100
  const hoursPerDay =
    typeof input.hoursPerDay === 'number' && Number.isFinite(input.hoursPerDay) && input.hoursPerDay > 0
      ? input.hoursPerDay
      : scheduledHoursPerDay(input.hoursPerWeek, input.workdaysPerWeek)
  /** Fraction of a scheduled day one absence row represents, capped at a full day. */
  const dayShare = (d: AbsenceDay) =>
    Number.isFinite(d.hours) && d.hours > 0 ? Math.min(1, d.hours / hoursPerDay) : 1
  // Full precision here; money is rounded where it is computed and
  // quantities where they are written, so 1/8 of a day does not become 0.13
  // before it is priced.
  const sumDays = (rows: AbsenceDay[]) => rows.reduce((sum, d) => sum + dayShare(d), 0)

  const hourlyPay = input.salaryType === 'hourly'
  // Hourly pay: the hours of semesterlönegrundande absence the base is topped
  // up with (SemL 16 b § tredje stycket). A row's hours are the hours the
  // employee would have worked that day; the table requires them, and the
  // scheduled day stands in for a caller that passes none (the statute's
  // "uppskattas" when the income cannot be established).
  let qualifyingAbsenceHours = 0
  const addQualifyingHours = (rows: AbsenceDay[]) => {
    if (!hourlyPay) return
    for (const d of rows) {
      const hours = Number(d.hours)
      qualifyingAbsenceHours += Number.isFinite(hours) && hours > 0 ? hours : hoursPerDay
    }
  }

  const periodSickRows = periodDays.filter(d => d.absence_type === 'sick')
  const periodSickDates = periodSickRows.map(d => d.absence_date)
  const vabDays = periodDays.filter(d => d.absence_type === 'vab')
  const parentalDays = periodDays.filter(d => d.absence_type === 'parental')
  const unpaidLeaveDays = periodDays.filter(d => d.absence_type === 'unpaid_leave')

  // Company conventions (lib/salary/calculation-policy.ts). Every default
  // keeps the historical derivation; the branches below are pure opt-ins.
  const policy = input.calculationPolicy
  const annualHourly = policy?.sick_rate === 'annual_hourly'
  const calendarLongLeave = policy?.long_leave === 'calendar_after_five_workdays'
  if (calendarLongLeave && ((input.workdaysPerWeek ?? 5) !== 5 || !input.periodStart || !input.periodEnd)) {
    throw new Error('Kalenderdagsavdrag kräver femdagarsvecka och en fullständig avvikelseperiod')
  }
  const hoursPerWeek =
    typeof input.hoursPerWeek === 'number' && Number.isFinite(input.hoursPerWeek) && input.hoursPerWeek > 0
      ? input.hoursPerWeek
      : hoursPerDay * 5
  /** Calendar-day deduction for one leave type over the in-window rows,
   *  with the surrounding context deciding episode length. */
  const calendarDeductionFor = (type: AbsenceType, calendarFromStart = false) => {
    const context = (input.contextDays ?? []).filter(
      d => d.absence_type === type &&
        (policy?.leave_context !== 'through_deviation_end' || d.absence_date <= input.periodEnd!),
    )
    return calendarLeaveDeduction({
      monthlySalary,
      hoursPerDay,
      dailyDivisor: input.dailyDivisor ?? 21,
      periodStart: input.periodStart!,
      periodEnd: input.periodEnd!,
      days: [...context, ...periodDays.filter(d => d.absence_type === type)],
      calendarFromStart,
    })
  }
  /** Split one calendar-rate total over the 120-date parts in proportion to
   *  their weighted days; the last part takes the öre remainder so the parts
   *  add up to the total exactly. */
  const allocateAcrossParts = (total: number, parts: VacationBasisPart[]): number[] => {
    const weights = parts.map(p => sumDays(p.rows))
    const weightSum = weights.reduce((sum, w) => sum + w, 0)
    let allocated = 0
    return parts.map((_, idx) => {
      if (idx === parts.length - 1) return r(total - allocated)
      const share = weightSum > 0 ? r((total * weights[idx]) / weightSum) : 0
      allocated = r(allocated + share)
      return share
    })
  }

  let flagFkReporting = false
  let flagLakarintyg = false

  if (periodSickDates.length > 0) {
    const periodMin = periodSickDates[0]

    // Hourly pay prices each sick row by its own hours. Without a timlön or
    // without the hours the sjuklön would silently be 0 kr, so refuse.
    const hourlyWage = hourlyPay ? Number(input.hourlyRate) : 0
    if (hourlyPay && !(Number.isFinite(hourlyWage) && hourlyWage > 0)) {
      throw new AbsenceInputError(
        'Timlön saknas: sjuklön för en timavlönad beräknas på timlönen. Ange timlön på den anställde och beräkna om.',
      )
    }
    /** What a sick row is priced in: its share of a scheduled day, or for
     *  hourly pay the hours the employee would have worked that day. */
    const sickUnits = (d: AbsenceDay) => {
      if (!hourlyPay) return dayShare(d)
      const hours = Number(d.hours)
      if (!(Number.isFinite(hours) && hours > 0)) {
        throw new AbsenceInputError(
          `Sjukdagen ${d.absence_date} saknar timmar: sjuklön för en timavlönad beräknas på de timmar ` +
            'den anställde skulle ha arbetat. Registrera sjukfrånvaron med antal timmar och beräkna om.',
        )
      }
      return hours
    }
    const sumSickUnits = (rows: AbsenceDay[]) => rows.reduce((sum, d) => sum + sickUnits(d), 0)
    // Every sick day is semesterlönegrundande (SemL 17 §; the 180-day cap is
    // not tracked, see the module comment), day 15+ included.
    addQualifyingHours(periodSickRows)

    // Build segments over (lookback ∪ period). Segments may straddle the
    // boundary; we need the full picture to classify each period day's
    // index within its segment.
    const allSickDates = [...input.lookbackSickDates, ...periodSickDates]
    const segments = buildSjukloneperioder(allSickDates, input.workdaysPerWeek)

    // Allmänt högriskskydd (Sjuklönelagen 11§): from the 11th sjuklöneperiod
    // within a rolling 12-month window, no karensavdrag is made.
    //
    // Interpretation: we count *sjuklöneperioder* in the lookback window. The
    // law's phrasing: "från och med den 11:e sjukperioden under en
    // tolvmånadersperiod görs inget karensavdrag": keys the cap to the
    // period count. An alternative reading is that cap-suppressed periods
    // shouldn't count toward future windows (only periods that actually
    // had karens deducted). That requires persisting per-period karens-
    // deduction state, which Accounted doesn't yet do. The period-count
    // reading can over-suppress karens for an employee who hits the cap
    // repeatedly: softer error than the opposite.
    //
    // Limitation: per-period karens deduction state is not persisted. The
    // karens amount already consumed by a period that continues from the
    // previous pay period is reconstructed from the prior sick hours at the
    // CURRENT daily rate, so a salary or schedule change inside one
    // sjuklöneperiod straddling a month boundary can shift the combined
    // karens by the rate difference.
    const cap = payrollConfig.maxKarensavdragPerYear ?? 10
    const cutoff = addDays(periodMin, -365)
    const lookbackOnlySegments = buildSjukloneperioder(
      input.lookbackSickDates.filter(d => d >= cutoff),
      input.workdaysPerWeek,
    )
    // Cutover adjustment: karens periods from the previous payroll system
    // that were never imported as day rows. Over-suppression of karens is
    // the softer error (consistent with the period-count reading above).
    let karensInWindow = lookbackOnlySegments.length + (input.karensPeriodsAdjustment ?? 0)

    // weeklyRate stays monthly x 12/52 by construction (schedule-independent);
    // only the DAILY rate scales with the workday schedule.
    const dailyRate = r(monthlySalary / (input.dailyDivisor ?? 21))
    const weeklyRate = r(monthlySalary * 12 / 52 * payrollConfig.sjuklonRate)
    // Hourly pay: a week's sjuklön is 80 % of timlön × the weekly hours.
    const karensAmount = hourlyPay
      ? r(r(hourlyWage * hoursPerWeek * payrollConfig.sjuklonRate) * payrollConfig.karensavdragFactor)
      : r(weeklyRate * payrollConfig.karensavdragFactor)
    // sick_rate = annual_hourly (Fortnox): timlön = månadslön × 12 / (52 ×
    // veckoarbetstid), priced per absent hour; sjuklön per timme is the
    // 80 % of that, rounded to öre before it is multiplied.
    const hourlyRate = r((monthlySalary * 12) / (52 * hoursPerWeek))
    const sickHourlyRate = r(hourlyRate * payrollConfig.sjuklonRate)
    /** Pay lost for a number of scheduled days (dagavdrag or timavdrag).
     *  Monthly pay only: an hourly employee's lost hours were never paid. */
    const lostPayFor = (dayCount: number) =>
      annualHourly ? r(hourlyRate * dayCount * hoursPerDay) : r(dailyRate * dayCount)
    /** Sjuklön (80 %) for a number of sick units: scheduled days, or for
     *  hourly pay the hours the employee would have worked. */
    const sickPayFor = (units: number) =>
      hourlyPay
        ? r(hourlyWage * payrollConfig.sjuklonRate * units)
        : annualHourly
          ? r(sickHourlyRate * units * hoursPerDay)
          : r(dailyRate * payrollConfig.sjuklonRate * units)
    // Lookback rows with hours, or every lookback date as a full day.
    const lookbackSickRows: AbsenceDay[] =
      input.lookbackSickDays ??
      input.lookbackSickDates.map(absence_date => ({ absence_date, absence_type: 'sick' as const, hours: hoursPerDay }))

    let day2_14CountTotal = 0
    let day2_14Dates = 0
    let day15PlusCountTotal = 0

    // Walk each segment that holds a period sick day. A segment of lookback
    // days alone was priced by an earlier run; it can lie after periodMin only
    // when a late day from an earlier period opens the period's days.
    for (const seg of segments) {
      if (!periodSickDates.some(d => d >= seg.startDate && d <= seg.endDate)) continue

      // The segment's days an earlier run already priced. They come before
      // its period days: a lookback day lies before the window, and a late
      // day placed before a priced one is refused (lateAbsenceRefusal).
      const priorSickRows = lookbackSickRows.filter(
        d => d.absence_date >= seg.startDate && d.absence_date <= seg.endDate,
      )
      const segmentStartsInPeriod = priorSickRows.length === 0

      // Karensavdrag for the segment (SjLL 6 §): one per sjuklöneperiod,
      // never larger than the sjuklön the period yields. The part a short
      // first day cannot absorb continues on the following sick days, also
      // when they fall in the next pay period: the prior period's sjuklön
      // (from the lookback rows) is what has already been consumed.
      const periodDaysInSjuklon = sumSickUnits(
        periodSickRows.filter(
          d => d.absence_date >= seg.startDate && d.absence_date <= seg.endDate &&
            sjukloneperiodDayIndex(seg, d.absence_date) <= 14,
        ),
      )
      const priorDaysInSjuklon = sumSickUnits(
        priorSickRows.filter(d => sjukloneperiodDayIndex(seg, d.absence_date) <= 14),
      )
      const karensEligible = segmentStartsInPeriod
        ? karensInWindow < cap
        // Continuing a period that started in the lookback: the karens was
        // eligible then iff the count of periods before it was under the cap.
        : (() => {
            const priorIndex = lookbackOnlySegments.findIndex(s => s.startDate === seg.startDate)
            return priorIndex >= 0 && priorIndex + (input.karensPeriodsAdjustment ?? 0) < cap
          })()
      const karensRemaining = r(Math.max(0, karensAmount - sickPayFor(priorDaysInSjuklon)))
      const karensNow = r(Math.min(karensRemaining, sickPayFor(periodDaysInSjuklon)))
      if (karensEligible && karensNow > 0) {
        lineItems.push({
          item_type: 'sick_karens',
          // Hourly pay names the weekly hours the average week rests on.
          description: hourlyPay
            ? `Karensavdrag (${seg.startDate}, ${hoursPerWeek} tim/vecka)`
            : `Karensavdrag (${seg.startDate})`,
          quantity: 1,
          amount: -karensNow,
          ...payslipLineFlags('sick_karens'),
        })
      }
      // Suppressed by allmänt högriskskydd: the period still counts toward
      // the window, the employee just keeps the full sjuklön.
      if (segmentStartsInPeriod) karensInWindow += 1

      // Classify each *period* sick row in this segment by its day of the
      // sjuklöneperiod (calendar days of its sick spells, 1-based; healthy
      // days between spells do not count), weighted by hours.
      for (const row of periodSickRows) {
        const d = row.absence_date
        if (d < seg.startDate || d > seg.endDate) continue
        const segDayIndex = sjukloneperiodDayIndex(seg, d)
        if (segDayIndex <= 14) {
          day2_14CountTotal += sickUnits(row)
          day2_14Dates += 1
          if (segDayIndex >= 8) flagLakarintyg = true
        } else {
          day15PlusCountTotal += dayShare(row)
          flagFkReporting = true
        }
      }
    }

    if (day2_14CountTotal > 0 && hourlyPay) {
      // The employer pays 80 % of the lost hours; nothing is deducted
      // because the hours were never in base pay. quantity is hours, the
      // unit the row is priced in.
      lineItems.push({
        item_type: 'sick_day2_14',
        description: `Sjuklön dag 1-14 (${day2_14Dates} dagar, ${r(day2_14CountTotal)} tim)`,
        quantity: r(day2_14CountTotal),
        amount: sickPayFor(day2_14CountTotal),
        // Pay for qualifying days stays out of the base, which gets the
        // hours at full timlön instead (qualifyingAbsenceHours).
        ...payslipLineFlags('sick_day2_14'),
      })
    } else if (day2_14CountTotal > 0) {
      const lostPay = lostPayFor(day2_14CountTotal)
      const sjuklon = sickPayFor(day2_14CountTotal)
      lineItems.push({
        // item_type kept for schema and report compatibility; the row covers
        // days 1-14 since day one also receives sjuklön.
        item_type: 'sick_day2_14',
        description: `Sjuklön dag 1-14 (${r(day2_14CountTotal)} dagar)`,
        quantity: r(day2_14CountTotal),
        // Net deduction vs full pay = lostPay - sjuklon (employer pays 80%).
        amount: -r(lostPay - sjuklon),
        // Qualifying sick days: the base keeps the full monthly salary, the
        // income the employee would have had (SemL 16 b § tredje stycket).
        ...payslipLineFlags('sick_day2_14'),
      })
    }

    // Hourly pay: day 15+ is Försäkringskassan's and there is no full salary
    // to take it back from, so no row (the FK reporting flag still stands).
    if (day15PlusCountTotal > 0 && !hourlyPay) {
      // long_leave = calendar_after_five_workdays prices the Försäkringskassan
      // phase per calendar day from its first day: the rows on segment day
      // 15+ (lookback and period) form the episodes, the in-window days are
      // deducted. Rows after the window cannot change an in-window
      // deduction that is already at the calendar rate, so no context is
      // needed here.
      const lostPay = calendarLongLeave
        ? calendarLeaveDeduction({
            monthlySalary,
            hoursPerDay,
            dailyDivisor: input.dailyDivisor ?? 21,
            periodStart: input.periodStart!,
            periodEnd: input.periodEnd!,
            days: [...lookbackSickRows, ...periodSickRows].filter(d =>
              segments.some(
                seg => d.absence_date >= seg.startDate && d.absence_date <= seg.endDate &&
                  sjukloneperiodDayIndex(seg, d.absence_date) > 14,
              ),
            ),
            calendarFromStart: true,
          })
        : r(dailyRate * day15PlusCountTotal)
      lineItems.push({
        item_type: 'sick_day15_plus',
        description: `Sjukfrånvaro dag 15+ (FK) (${r(day15PlusCountTotal)} dagar)`,
        quantity: r(day15PlusCountTotal),
        // Employer pays nothing: full daily rate deducted.
        amount: -lostPay,
        ...payslipLineFlags('sick_day15_plus'),
      })
    }
  }

  // The calculators' own semesterGrundande verdict is ignored: it judges the
  // period as a whole, while the part a row belongs to decides its flag.
  // A row past the cap says so in its description, so the payslip explains
  // why the vacation basis is lower that month.
  const vacationBasisSuffix = (qualifies: boolean) => (qualifies ? '' : ', ej semestergrundande')

  // ── VAB ────────────────────────────────────────────────────────────────
  // SemL 17 a § första stycket 1: 120 calendar dates per intjänandeår are
  // semestergrundande; the split is by date, the deduction by weighted hours.
  // The deduction enters the base only past the cap (module comment).
  const vabCount = vabDays.length
  if (vabCount > 0) {
    for (const part of splitAtVacationBasisCap(vabDays, input.vabDaysYtd)) {
      const vabEquivalentDays = sumDays(part.rows)
      const vab = calculateVabDeduction(monthlySalary, vabEquivalentDays, input.vabDaysYtd, input.dailyDivisor)
      if (part.qualifies) addQualifyingHours(part.rows)
      lineItems.push({
        item_type: 'vab',
        description: `VAB (${part.rows.length} dagar${vacationBasisSuffix(part.qualifies)})`,
        quantity: r(vabEquivalentDays),
        amount: -vab.deduction,
        ...payslipLineFlags('vab'),
        is_vacation_basis: !part.qualifies,
      })
    }
  }

  // ── Parental leave ─────────────────────────────────────────────────────
  // SemL 17 a § första stycket 3: 120 calendar dates per child, split as
  // above and entering the base only past the cap. Under the
  // calendar convention the episode is priced as a whole (the split is about
  // semesterunderlag, not about how long the leave is) and the total is
  // shared over the parts by their weighted days.
  const parentalCount = parentalDays.length
  if (parentalCount > 0) {
    const parentalParts = splitAtVacationBasisCap(parentalDays, input.parentalDaysPregnancyYtd)
    const calendarParental = calendarLongLeave
      ? allocateAcrossParts(calendarDeductionFor('parental'), parentalParts)
      : null
    for (const [idx, part] of parentalParts.entries()) {
      const parentalEquivalentDays = sumDays(part.rows)
      const parental = calculateParentalLeaveDeduction(
        monthlySalary,
        parentalEquivalentDays,
        input.parentalDaysPregnancyYtd,
        input.dailyDivisor,
      )
      if (part.qualifies) addQualifyingHours(part.rows)
      lineItems.push({
        item_type: 'parental_leave',
        description: `Föräldraledighet (${part.rows.length} dagar${vacationBasisSuffix(part.qualifies)})`,
        quantity: r(parentalEquivalentDays),
        amount: -(calendarParental ? calendarParental[idx] : parental.deduction),
        ...payslipLineFlags('parental_leave'),
        is_vacation_basis: !part.qualifies,
      })
    }
  }

  // ── Unpaid leave (tjänstledighet utan lön) ─────────────────────────────
  // Each day reduces gross pay by one daily rate (monthlySalary / 21: same
  // convention used elsewhere in the engine). Not semesterlönegrundande (it is
  // none of the absence 17-17 b §§ list), so the pay never earned lowers the
  // procentregeln base.
  const unpaidLeaveCount = unpaidLeaveDays.length
  if (unpaidLeaveCount > 0) {
    const dailyRate = r(monthlySalary / (input.dailyDivisor ?? 21))
    const unpaidEquivalentDays = sumDays(unpaidLeaveDays)
    const deduction = calendarLongLeave
      ? calendarDeductionFor('unpaid_leave')
      : r(dailyRate * unpaidEquivalentDays)
    lineItems.push({
      item_type: 'unpaid_leave',
      description: `Tjänstledighet utan lön (${unpaidLeaveCount} dagar)`,
      quantity: r(unpaidEquivalentDays),
      amount: -deduction,
      ...payslipLineFlags('unpaid_leave'),
    })
  }

  return {
    lineItems,
    aggregated: {
      sickDays: periodSickDates.length,
      vabDays: vabCount,
      parentalDays: parentalCount,
      unpaidLeaveDays: unpaidLeaveCount,
    },
    flagFkReporting,
    flagLakarintyg,
    qualifyingAbsenceHours: r(qualifyingAbsenceHours),
  }
}

/** One employee's absence rows, as a salary calculation reads them. */
export interface EmployeeAbsenceRows {
  /** Rows the run deducts, by date: its window's own rows and its late days. */
  periodDays: AbsenceDay[]
  /**
   * The late days among periodDays: rows from an earlier, already paid or
   * declared period carried to this run (lib/salary/late-days.ts).
   */
  lateDays: AbsenceDay[]
  /** Rows within a month either side of the window (calendar convention only). */
  contextDays: AbsenceDay[]
  /** Sick rows in the 365 days before the window. */
  lookbackSickDays: AbsenceDay[]
  /** VAB dates from the start of the intjänandeår to the window start. */
  vabDaysYtd: number
  /** Parental leave dates from the start of the intjänandeår to the window start. */
  parentalDaysPregnancyYtd: number
}

const NO_ABSENCE: EmployeeAbsenceRows = {
  periodDays: [],
  lateDays: [],
  contextDays: [],
  lookbackSickDays: [],
  vabDaysYtd: 0,
  parentalDaysPregnancyYtd: 0,
}

/** The fields derivation reads; the queries also carry employee_id to group by. */
function absenceDay(row: AbsenceDay): AbsenceDay {
  return { absence_date: row.absence_date, absence_type: row.absence_type, hours: row.hours }
}

function byDateThenType(a: AbsenceDay, b: AbsenceDay): number {
  if (a.absence_date !== b.absence_date) return a.absence_date < b.absence_date ? -1 : 1
  return a.absence_type < b.absence_type ? -1 : a.absence_type > b.absence_type ? 1 : 0
}

/**
 * Load the absence rows of every employee on a salary run in four reads,
 * whatever the roster size: the deviation window (widened by a month either
 * side under the calendar convention, which reads those rows as context),
 * the late days carried to the run, the 365-day sick lookback, and the
 * intjänandeår's VAB and parental dates before the window (SemL 17 a §: the
 * 120-date cap counts within it). Paginated: a roster's year of sick days
 * passes PostgREST's 1000-row cap long before an employer is large.
 *
 * The reading rule is late-days.ts's: a row carried to another run is never
 * one of this window's days, and a row carried to this run (or to a run it
 * corrects) is deducted here whatever its date, so it is left out of the
 * lookback and the year to date, which would count it twice. A row carried
 * elsewhere still counts there: the day happened, and another run settles it.
 *
 * A failed window, late-day or lookback read throws: a calculation without
 * them would pay sick leave as if none was registered. A failed year-to-date
 * read counts as no earlier dates, as it always has.
 */
export async function loadRunAbsence(
  supabase: SupabaseClient,
  params: {
    companyId: string
    employeeIds: string[]
    periodStart: string
    periodEnd: string
    /** Read the surrounding month too (long_leave = calendar_after_five_workdays). */
    withContext: boolean
    /** First day of the intjänandeår the window falls in (getVacationYearStart
     *  under the company's basis): where the VAB and parental date count
     *  starts. Omitted = 1 January of the window's year, the calendar basis. */
    earningYearStart?: string
    /** The run and the runs it corrects (lateDayReaderRunIds): whose late days it deducts. */
    readerRunIds: readonly string[]
  },
): Promise<Map<string, EmployeeAbsenceRows>> {
  const { companyId, employeeIds, periodStart, periodEnd, withContext, readerRunIds } = params
  const byEmployee = new Map<string, EmployeeAbsenceRows>()
  if (employeeIds.length === 0) return byEmployee
  const forEmployee = (employeeId: string) => {
    let rows = byEmployee.get(employeeId)
    if (!rows) {
      rows = {
        periodDays: [],
        lateDays: [],
        contextDays: [],
        lookbackSickDays: [],
        vabDaysYtd: 0,
        parentalDaysPregnancyYtd: 0,
      }
      byEmployee.set(employeeId, rows)
    }
    return rows
  }
  type EmployeeAbsenceDay = AbsenceDay & { employee_id: string; carried_to_run_id?: string | null }
  const carriedHere = (row: EmployeeAbsenceDay) =>
    Boolean(row.carried_to_run_id) && readerRunIds.includes(row.carried_to_run_id as string)
  // Every read orders by (employee_id, absence_date, absence_type), which is
  // unique: a total order for paging, and date order within an employee.
  const read = (
    label: string,
    query: (range: { from: number; to: number }) => PromiseLike<{
      data: EmployeeAbsenceDay[] | null
      error: { message: string } | null
    }>,
  ) =>
    fetchAllRows(query).catch((err: unknown) => {
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    })

  const yearStart = params.earningYearStart ?? `${periodStart.slice(0, 4)}-01-01`
  const [windowRows, lateRows, lookbackRows, ytdRows] = await Promise.all([
    read('Failed to load absence days', ({ from, to }) =>
      supabase
        .from('salary_absence_days')
        .select('employee_id, absence_date, absence_type, hours, carried_to_run_id')
        .eq('company_id', companyId)
        .in('employee_id', employeeIds)
        .gte('absence_date', withContext ? addDays(periodStart, -31) : periodStart)
        .lte('absence_date', withContext ? addDays(periodEnd, 31) : periodEnd)
        .order('employee_id')
        .order('absence_date')
        .order('absence_type')
        .range(from, to),
    ),
    read('Failed to load late absence days', ({ from, to }) =>
      supabase
        .from('salary_absence_days')
        .select('employee_id, absence_date, absence_type, hours, carried_to_run_id')
        .eq('company_id', companyId)
        .in('employee_id', employeeIds)
        .in('carried_to_run_id', [...readerRunIds])
        .order('employee_id')
        .order('absence_date')
        .order('absence_type')
        .range(from, to),
    ),
    read('Failed to load absence lookback', ({ from, to }) =>
      supabase
        .from('salary_absence_days')
        .select('employee_id, absence_date, absence_type, hours, carried_to_run_id')
        .eq('company_id', companyId)
        .in('employee_id', employeeIds)
        .eq('absence_type', 'sick')
        .gte('absence_date', addDays(periodStart, -365))
        .lt('absence_date', periodStart)
        .order('employee_id')
        .order('absence_date')
        .order('absence_type')
        .range(from, to),
    ),
    read('Failed to load absence year to date', ({ from, to }) =>
      supabase
        .from('salary_absence_days')
        .select('employee_id, absence_date, absence_type, hours, carried_to_run_id')
        .eq('company_id', companyId)
        .in('employee_id', employeeIds)
        .in('absence_type', ['vab', 'parental'])
        .gte('absence_date', yearStart)
        .lt('absence_date', periodStart)
        .order('employee_id')
        .order('absence_date')
        .order('absence_type')
        .range(from, to),
    ).catch(() => [] as EmployeeAbsenceDay[]),
  ])

  for (const row of windowRows) {
    // A late day of this run arrives with the late read; one carried to
    // another run is never a day of this window, only context outside it.
    if (carriedHere(row)) continue
    const rows = forEmployee(row.employee_id)
    const inWindow = row.absence_date >= periodStart && row.absence_date <= periodEnd
    if (!inWindow) rows.contextDays.push(absenceDay(row))
    else if (!row.carried_to_run_id) rows.periodDays.push(absenceDay(row))
  }
  for (const row of lateRows) {
    const rows = forEmployee(row.employee_id)
    rows.periodDays.push(absenceDay(row))
    rows.lateDays.push(absenceDay(row))
  }
  for (const rows of byEmployee.values()) rows.periodDays.sort(byDateThenType)
  for (const row of lookbackRows) {
    if (!carriedHere(row)) forEmployee(row.employee_id).lookbackSickDays.push(absenceDay(row))
  }
  for (const row of ytdRows) {
    if (carriedHere(row)) continue
    const rows = forEmployee(row.employee_id)
    if (row.absence_type === 'vab') rows.vabDaysYtd += 1
    else rows.parentalDaysPregnancyYtd += 1
  }
  return byEmployee
}

/**
 * Why the late days among `rows` cannot be priced as the run's own days, in
 * Swedish for the person running payroll, or null when they can. Two cases
 * the engine has no state for, refused by name rather than priced wrong:
 *
 *   - long_leave = calendar_after_five_workdays: an episode is priced from
 *     its full length within one window; days from an earlier window cannot
 *     join one.
 *   - a late sick day before a sick day an earlier run already priced in the
 *     same sjuklöneperiod: that run decided karensavdrag and day numbers
 *     without it. A late day after the priced days continues the period the
 *     normal way: the lookback carries what was already deducted.
 *   - a late VAB or parental day the run deducts nothing for (hourly pay, or
 *     no monthly salary this run): its frånvarouppgift would be filed for a
 *     pay it did not affect (lib/salary/late-days.ts).
 */
export function lateAbsenceRefusal(
  rows: EmployeeAbsenceRows,
  opts: {
    calendarLongLeave: boolean
    workdaysPerWeek?: number | null
    /** Why the run deducts nothing for absence: hourly pay, or no monthly salary. */
    noDeduction?: 'hourly' | 'no_salary' | null
  },
): string | null {
  if (rows.lateDays.length === 0) return null
  if (opts.calendarLongLeave) {
    const priced = rows.lateDays.filter((d) => CALENDAR_PRICED_ABSENCE_TYPES.includes(d.absence_type))
    if (priced.length > 0) {
      const dates = [...new Set(priced.map((d) => d.absence_date))].sort()
      return (
        `Frånvaro från en tidigare period (${dates[0]}${dates.length > 1 ? ` till ${dates[dates.length - 1]}` : ''}) ` +
        'kan inte räknas i den här körningen när företaget drar lång frånvaro per kalenderdag. ' +
        'Ta bort de sena dagarna och lägg in avdraget som en egen rad på lönebeskedet.'
      )
    }
  }
  if (opts.noDeduction) {
    const reported = rows.lateDays.filter((d) => FRANVARO_ABSENCE_TYPES.includes(d.absence_type))
    if (reported.length > 0) {
      const dates = [...new Set(reported.map((d) => d.absence_date))].sort()
      return (
        `VAB och föräldraledighet från en tidigare period (${dates[0]}${dates.length > 1 ? ` till ${dates[dates.length - 1]}` : ''}) ` +
        `drar inget från lönen i den här körningen, eftersom ${opts.noDeduction === 'hourly' ? 'den anställde har timlön' : 'månadslönen är 0 kr'}. ` +
        'En frånvarouppgift lämnas bara för en lön som frånvaron påverkar: ta bort de sena dagarna från körningen.'
      )
    }
  }
  const lateSick = rows.lateDays.filter((d) => d.absence_type === 'sick').map((d) => d.absence_date)
  if (lateSick.length === 0) return null
  const pricedSick = rows.lookbackSickDays.map((d) => d.absence_date)
  const periodSick = rows.periodDays.filter((d) => d.absence_type === 'sick').map((d) => d.absence_date)
  for (const segment of buildSjukloneperioder([...pricedSick, ...periodSick], opts.workdaysPerWeek)) {
    const lateInSegment = lateSick.filter((d) => d >= segment.startDate && d <= segment.endDate).sort()
    if (lateInSegment.length === 0) continue
    const pricedAfter = pricedSick.filter((d) => d > lateInSegment[0] && d <= segment.endDate).sort()
    if (pricedAfter.length > 0) {
      return (
        `Sjukdagen ${lateInSegment[0]} är registrerad i efterhand men ligger före sjukdagen ${pricedAfter[0]} ` +
        'i samma sjuklöneperiod, som en tidigare lönekörning redan har räknat. Karensavdrag och sjuklön för ' +
        'perioden kan då inte räknas om här: ta bort den sena dagen och lägg in skillnaden som en egen rad på lönebeskedet.'
      )
    }
  }
  return null
}

/**
 * Derive one employee's absence lines from the rows loadRunAbsence read.
 * An employee without rows derives nothing. Late days are priced as the
 * run's own days; the ones that cannot be (lateAbsenceRefusal) throw an
 * AbsenceInputError naming them.
 */
export function deriveEmployeeAbsence(params: {
  rows: EmployeeAbsenceRows | undefined
  monthlySalary: number
  /** See DeriveInput.salaryType. */
  salaryType?: 'monthly' | 'hourly'
  /** See DeriveInput.hourlyRate. */
  hourlyRate?: number | null
  payrollConfig: PayrollConfig
  periodStart: string
  periodEnd: string
  /** See DeriveInput.karensPeriodsAdjustment. */
  karensPeriodsAdjustment?: number
  /** See DeriveInput.dailyDivisor. */
  dailyDivisor?: number
  /** See DeriveInput.hoursPerDay. */
  hoursPerDay?: number
  /** See DeriveInput.hoursPerWeek. */
  hoursPerWeek?: number
  /** See DeriveInput.workdaysPerWeek. */
  workdaysPerWeek?: number
  /** See DeriveInput.calculationPolicy. */
  calculationPolicy?: SalaryCalculationPolicy
}): DeriveResult {
  const rows = params.rows ?? NO_ABSENCE
  const lateRefusal = lateAbsenceRefusal(rows, {
    calendarLongLeave: params.calculationPolicy?.long_leave === 'calendar_after_five_workdays',
    workdaysPerWeek: params.workdaysPerWeek,
    noDeduction: params.salaryType === 'hourly' ? 'hourly' : params.monthlySalary > 0 ? null : 'no_salary',
  })
  if (lateRefusal) throw new AbsenceInputError(lateRefusal)
  return deriveAbsenceLineItems({
    monthlySalary: params.monthlySalary,
    salaryType: params.salaryType,
    hourlyRate: params.hourlyRate,
    payrollConfig: params.payrollConfig,
    periodDays: rows.periodDays,
    lookbackSickDates: rows.lookbackSickDays.map(r => r.absence_date),
    lookbackSickDays: rows.lookbackSickDays,
    vabDaysYtd: rows.vabDaysYtd,
    parentalDaysPregnancyYtd: rows.parentalDaysPregnancyYtd,
    karensPeriodsAdjustment: params.karensPeriodsAdjustment,
    dailyDivisor: params.dailyDivisor,
    hoursPerDay: params.hoursPerDay,
    hoursPerWeek: params.hoursPerWeek,
    workdaysPerWeek: params.workdaysPerWeek,
    calculationPolicy: params.calculationPolicy,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    contextDays: rows.contextDays,
  })
}
