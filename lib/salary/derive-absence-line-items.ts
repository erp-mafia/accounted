import type { SupabaseClient } from '@supabase/supabase-js'
import type { PayrollConfig } from './payroll-config'
import { daysBetweenIso } from '@/lib/dates/iso'
import {
  calculateVabDeduction,
  calculateParentalLeaveDeduction,
} from './absence-calculator'
import type { SalaryCalculationPolicy } from './calculation-policy'
import { calendarLeaveDeduction } from './calendar-leave'

/**
 * Derive payroll line items from per-day absence records.
 *
 * Why this lives outside the existing absence-calculator: those formulas
 * still take `sickDays: number`. They cannot determine sjuklöneperiod
 * boundaries, återinsjuknande, or högriskskydd: those depend on actual
 * dates, which now live in `salary_absence_days`. This module is the
 * bridge: it walks the per-day records and emits correctly-classified
 * line items.
 *
 * Swedish payroll rules implemented:
 *   - **Sjuklöneperiod** (Sjuklönelagen) = first sick day → calendar-day 14.
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
 *   - **Allmänt högriskskydd**: max 10 karensavdrag per rolling 12-month
 *     window (inclusive of the new one). The 11th is suppressed.
 *
 * For VAB and parental leave, days are aggregated within the pay period and
 * forwarded to the existing calculators with YTD context. The 120-date
 * semestergrundande cap (SemL 17 § for VAB, 17 a § for parental leave) is
 * applied per date: when the 120th date falls inside the period, the dates
 * up to and including it form one row that is semestergrundande and the
 * dates after it a second row that is not.
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

export interface DerivedLineItem {
  item_type: 'sick_karens' | 'sick_day2_14' | 'sick_day15_plus' | 'vab' | 'parental_leave' | 'unpaid_leave'
  description: string
  quantity: number
  amount: number
  is_taxable: boolean
  is_avgift_basis: boolean
  is_vacation_basis: boolean
  is_gross_deduction: boolean
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
}

interface SjukloneperiodSegment {
  startDate: string
  endDate: string
  /** Number of *sick days* in this merged segment (not calendar days). */
  sickDayCount: number
  /** True if this segment is the continuation of a prior segment via
   *  återinsjuknande (gap within sjukloneperiodGapTolerance). No new
   *  karensavdrag. */
  isAterinsjuknande: boolean
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/** SemL 17 § (VAB) and 17 a § (parental leave): calendar dates per
 *  intjänandeår, respectively per pregnancy, that stay semesterlönegrundande. */
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

/**
 * Walk the (sorted ascending) sick dates and merge them into sjuklöneperioder
 * using the SjLL återinsjuknande rule: a gap of 1 to `tolerance` calendar
 * days = same period continues; a wider gap = new period. The tolerance is
 * 5 at a five-day week and grows for sparser schedules, see
 * sjukloneperiodGapTolerance.
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

  const flush = (gapToNext: number | null) => {
    segments.push({
      startDate,
      endDate,
      sickDayCount: count,
      // The *first* segment is never återinsjuknande (no prior period).
      // For subsequent segments, this flag is set below when starting a new one.
      isAterinsjuknande: false,
    })
    void gapToNext
  }

  for (let i = 1; i < sorted.length; i++) {
    const date = sorted[i]
    const gap = daysBetweenIso(endDate, date)
    if (gap === 0) continue
    if (gap >= 1 && gap <= tolerance) {
      // Within the tolerance: same period (contiguous OR återinsjuknande)
      endDate = date
      count += 1
      continue
    }
    // gap > tolerance: close current segment, start new one
    flush(gap)
    startDate = date
    endDate = date
    count = 1
  }
  flush(null)

  // Annotate isAterinsjuknande based on inter-segment gap (only meaningful if
  // the gap from prior segment's end to this segment's start is 1-5 days,
  // which the merge logic above already excludes: so this stays false. The
  // återinsjuknande logic is fully captured by the merge above; we keep the
  // flag for caller introspection if they pass in pre-segmented data.)
  return segments
}

export interface DeriveInput {
  monthlySalary: number
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
   *  Defaults to 8. Absence hours above it count as one full day. */
  hoursPerDay?: number
  /** Year-to-date VAB days for this employee, excluding the current period. */
  vabDaysYtd: number
  /** Parental leave days in the current pregnancy window (best-effort:
   *  defaults to calendar-year aggregate). */
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
  /** Scheduled hours per week (employment-degree adjusted). Only read under
   *  sick_rate = annual_hourly; defaults to hoursPerDay × 5. */
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
      : 8
  /** Fraction of a scheduled day one absence row represents, capped at a full day. */
  const dayShare = (d: AbsenceDay) =>
    Number.isFinite(d.hours) && d.hours > 0 ? Math.min(1, d.hours / hoursPerDay) : 1
  // Full precision here; money is rounded where it is computed and
  // quantities where they are written, so 1/8 of a day does not become 0.13
  // before it is priced.
  const sumDays = (rows: AbsenceDay[]) => rows.reduce((sum, d) => sum + dayShare(d), 0)

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
    // TODO: persist per-period karens deduction state if the period-count
    // reading produces complaints in the field. The same state would carry
    // the karens amount already consumed by a period that continues from
    // the previous pay period; today that is reconstructed from the prior
    // sick hours at the CURRENT daily rate, so a salary or schedule change
    // inside one sjuklöneperiod straddling a month boundary can shift the
    // combined karens by the rate difference.
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
    const karensAmount = r(weeklyRate * payrollConfig.karensavdragFactor)
    // sick_rate = annual_hourly (Fortnox): timlön = månadslön × 12 / (52 ×
    // veckoarbetstid), priced per absent hour; sjuklön per timme is the
    // 80 % of that, rounded to öre before it is multiplied.
    const hourlyRate = r((monthlySalary * 12) / (52 * hoursPerWeek))
    const sickHourlyRate = r(hourlyRate * payrollConfig.sjuklonRate)
    /** Pay lost for a number of scheduled days (dagavdrag or timavdrag). */
    const lostPayFor = (dayCount: number) =>
      annualHourly ? r(hourlyRate * dayCount * hoursPerDay) : r(dailyRate * dayCount)
    /** Sjuklön (80 %) for a number of scheduled days. */
    const sickPayFor = (dayCount: number) =>
      annualHourly
        ? r(sickHourlyRate * dayCount * hoursPerDay)
        : r(dailyRate * payrollConfig.sjuklonRate * dayCount)
    // Lookback rows with hours, or every lookback date as a full day.
    const lookbackSickRows: AbsenceDay[] =
      input.lookbackSickDays ??
      input.lookbackSickDates.map(absence_date => ({ absence_date, absence_type: 'sick' as const, hours: hoursPerDay }))

    let day2_14CountTotal = 0
    let day15PlusCountTotal = 0

    // Walk each segment that touches the period.
    for (const seg of segments) {
      // Skip segments that don't touch the period at all.
      if (seg.endDate < periodMin) continue
      if (seg.startDate > periodSickDates[periodSickDates.length - 1]) continue

      const segmentStartsInPeriod = seg.startDate >= periodMin

      // Karensavdrag for the segment (SjLL 6 §): one per sjuklöneperiod,
      // never larger than the sjuklön the period yields. The part a short
      // first day cannot absorb continues on the following sick days, also
      // when they fall in the next pay period: the prior period's sjuklön
      // (from the lookback rows) is what has already been consumed.
      const periodDaysInSjuklon = sumDays(
        periodSickRows.filter(
          d => d.absence_date >= seg.startDate && d.absence_date <= seg.endDate &&
            daysBetweenIso(seg.startDate, d.absence_date) < 14,
        ),
      )
      const priorDaysInSjuklon = sumDays(
        lookbackSickRows.filter(
          d => d.absence_date >= seg.startDate && d.absence_date < periodMin &&
            daysBetweenIso(seg.startDate, d.absence_date) < 14,
        ),
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
          description: `Karensavdrag (${seg.startDate})`,
          quantity: 1,
          amount: -karensNow,
          is_taxable: true,
          is_avgift_basis: true,
          is_vacation_basis: false,
          is_gross_deduction: true,
        })
      }
      // Suppressed by allmänt högriskskydd: the period still counts toward
      // the window, the employee just keeps the full sjuklön.
      if (segmentStartsInPeriod) karensInWindow += 1

      // Classify each *period* sick row in this segment by its segment day
      // index (calendar days from segment start, 1-based), weighted by hours.
      for (const row of periodSickRows) {
        const d = row.absence_date
        if (d < seg.startDate || d > seg.endDate) continue
        const segDayIndex = daysBetweenIso(seg.startDate, d) + 1
        if (segDayIndex <= 14) {
          day2_14CountTotal += dayShare(row)
          if (segDayIndex >= 8) flagLakarintyg = true
        } else {
          day15PlusCountTotal += dayShare(row)
          flagFkReporting = true
        }
      }
    }

    if (day2_14CountTotal > 0) {
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
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: true,
      })
    }

    if (day15PlusCountTotal > 0) {
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
                  daysBetweenIso(seg.startDate, d.absence_date) >= 14,
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
        is_taxable: true,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: true,
      })
    }
  }

  // The calculators' own semesterGrundande verdict is ignored: it judges the
  // period as a whole, while the part a row belongs to decides its flag.
  // A row past the cap says so in its description, so the payslip explains
  // why the vacation basis is lower that month.
  const vacationBasisSuffix = (qualifies: boolean) => (qualifies ? '' : ', ej semestergrundande')

  // ── VAB ────────────────────────────────────────────────────────────────
  // SemL 17 §: 120 calendar dates per intjänandeår are semestergrundande;
  // the split is by date, the deduction by weighted hours.
  const vabCount = vabDays.length
  if (vabCount > 0) {
    for (const part of splitAtVacationBasisCap(vabDays, input.vabDaysYtd)) {
      const vabEquivalentDays = sumDays(part.rows)
      const vab = calculateVabDeduction(monthlySalary, vabEquivalentDays, input.vabDaysYtd, input.dailyDivisor)
      lineItems.push({
        item_type: 'vab',
        description: `VAB (${part.rows.length} dagar${vacationBasisSuffix(part.qualifies)})`,
        quantity: r(vabEquivalentDays),
        amount: -vab.deduction,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: part.qualifies,
        is_gross_deduction: true,
      })
    }
  }

  // ── Parental leave ─────────────────────────────────────────────────────
  // SemL 17 a §: 120 calendar dates per pregnancy, split as above. Under the
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
      lineItems.push({
        item_type: 'parental_leave',
        description: `Föräldraledighet (${part.rows.length} dagar${vacationBasisSuffix(part.qualifies)})`,
        quantity: r(parentalEquivalentDays),
        amount: -(calendarParental ? calendarParental[idx] : parental.deduction),
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: part.qualifies,
        is_gross_deduction: true,
      })
    }
  }

  // ── Unpaid leave (tjänstledighet utan lön) ─────────────────────────────
  // Each day reduces gross pay by one daily rate (monthlySalary / 21: same
  // convention used elsewhere in the engine). Not semestergrundande per SemL
  // 17 § (only paid leave types accrue vacation).
  //
  // is_gross_deduction is deliberately false: the engine's Step 3 absence
  // sum already subtracts items whose item_type is 'unpaid_leave', so setting
  // the flag would double-count the amount in Step 4's gross_deduction sum.
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
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: false,
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
  }
}

/**
 * Convenience: load all DB inputs and derive in one call. Used by the
 * salary calculate route.
 */
export async function loadAndDeriveAbsence(params: {
  supabase: SupabaseClient
  companyId: string
  employeeId: string
  monthlySalary: number
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
}): Promise<DeriveResult> {
  const { supabase, companyId, employeeId, periodStart, periodEnd } = params

  const { data: periodRows, error: periodErr } = await supabase
    .from('salary_absence_days')
    .select('absence_date, absence_type, hours')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .gte('absence_date', periodStart)
    .lte('absence_date', periodEnd)
    .order('absence_date', { ascending: true })
  if (periodErr) throw new Error(`Failed to load absence days: ${periodErr.message}`)
  const periodDays = (periodRows ?? []) as AbsenceDay[]

  // Surrounding month on each side, only under the calendar convention: it
  // decides whether an episode that touches the window edge is longer than
  // five working days. Rows inside the window are already in periodDays.
  let contextDays: AbsenceDay[] = []
  if (params.calculationPolicy?.long_leave === 'calendar_after_five_workdays') {
    const { data: contextRows, error: contextErr } = await supabase
      .from('salary_absence_days')
      .select('absence_date, absence_type, hours')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .gte('absence_date', addDays(periodStart, -31))
      .lte('absence_date', addDays(periodEnd, 31))
    if (contextErr) throw new Error(`Failed to load absence context: ${contextErr.message}`)
    contextDays = ((contextRows ?? []) as AbsenceDay[]).filter(
      d => d.absence_date < periodStart || d.absence_date > periodEnd,
    )
  }

  const lookbackStart = addDays(periodStart, -365)
  const { data: lookbackRows, error: lookbackErr } = await supabase
    .from('salary_absence_days')
    .select('absence_date, absence_type, hours')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('absence_type', 'sick')
    .gte('absence_date', lookbackStart)
    .lt('absence_date', periodStart)
  if (lookbackErr) throw new Error(`Failed to load absence lookback: ${lookbackErr.message}`)
  const lookbackSickDays = (lookbackRows ?? []) as AbsenceDay[]
  const lookbackSickDates = lookbackSickDays.map(r => r.absence_date)

  const yearStart = `${periodStart.slice(0, 4)}-01-01`
  const { data: vabYtd } = await supabase
    .from('salary_absence_days')
    .select('absence_date')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('absence_type', 'vab')
    .gte('absence_date', yearStart)
    .lt('absence_date', periodStart)
  const vabDaysYtd = vabYtd?.length ?? 0

  const { data: parentalYtd } = await supabase
    .from('salary_absence_days')
    .select('absence_date')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('absence_type', 'parental')
    .gte('absence_date', yearStart)
    .lt('absence_date', periodStart)
  const parentalDaysPregnancyYtd = parentalYtd?.length ?? 0

  return deriveAbsenceLineItems({
    monthlySalary: params.monthlySalary,
    payrollConfig: params.payrollConfig,
    periodDays,
    lookbackSickDates,
    lookbackSickDays,
    vabDaysYtd,
    parentalDaysPregnancyYtd,
    karensPeriodsAdjustment: params.karensPeriodsAdjustment,
    dailyDivisor: params.dailyDivisor,
    hoursPerDay: params.hoursPerDay,
    hoursPerWeek: params.hoursPerWeek,
    workdaysPerWeek: params.workdaysPerWeek,
    calculationPolicy: params.calculationPolicy,
    periodStart,
    periodEnd,
    contextDays,
  })
}
