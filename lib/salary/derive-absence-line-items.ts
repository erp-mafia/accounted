import type { SupabaseClient } from '@supabase/supabase-js'
import type { PayrollConfig } from './payroll-config'
import { daysBetweenIso } from '@/lib/dates/iso'
import type { SalaryCalculationPolicy } from './calculation-policy'
import { calendarLeaveDeduction } from './calendar-leave'
import {
  calculateVabDeduction,
  calculateParentalLeaveDeduction,
} from './absence-calculator'

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
 *     Days 1-14 receive sjuklön at 80%, less one capped karensavdrag.
 *     Day 15+ is Försäkringskassan; employer pays nothing but must report.
 *   - **Återinsjuknande**: if the next sick day is within 5 calendar days of
 *     the previous sjuklöneperiod's last day, both merge: no new karens.
 *   - **Allmänt högriskskydd**: max 10 karensavdrag per rolling 12-month
 *     window (inclusive of the new one). The 11th is suppressed.
 *
 * For VAB and parental leave, days are aggregated within the pay period and
 * forwarded to the existing calculators with YTD context.
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
   *  återinsjuknande (gap 1-5 calendar days). No new karensavdrag. */
  isAterinsjuknande: boolean
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

function dateOnly(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

function addDays(d: string, n: number): string {
  const t = new Date(dateOnly(d).getTime() + n * ONE_DAY_MS)
  return t.toISOString().slice(0, 10)
}

/**
 * Walk the (sorted ascending) sick dates and merge them into sjuklöneperioder
 * using the SjLL återinsjuknande rule: gap of 1-5 calendar days = same
 * period continues; gap ≥ 6 = new period.
 */
export function buildSjukloneperioder(sickDates: string[]): SjukloneperiodSegment[] {
  if (sickDates.length === 0) return []
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
    if (gap >= 1 && gap <= 5) {
      // Within 5 calendar days: same period (contiguous OR återinsjuknande)
      endDate = date
      count += 1
      continue
    }
    // gap > 5: close current segment, start new one
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
  /** Actual prior hours are needed when karens spans a month boundary. */
  lookbackSickDays?: AbsenceDay[]
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
  /** Scheduled hours per working day, after employment-degree adjustment. */
  hoursPerDay?: number
  hoursPerWeek?: number
  workdaysPerWeek?: number
  calculationPolicy?: SalaryCalculationPolicy
  periodStart?: string
  periodEnd?: string
  /** Surrounding actual records to identify leave crossing the month boundary. */
  contextDays?: AbsenceDay[]
}

export function deriveAbsenceLineItems(input: DeriveInput): DeriveResult {
  const hoursPerDay = input.hoursPerDay ?? 8
  if (!Number.isFinite(hoursPerDay) || hoursPerDay <= 0) throw new Error('Arbetsschemats timmar per dag måste vara större än noll')
  for (const day of input.periodDays) {
    if (!Number.isFinite(day.hours) || day.hours < 0 || day.hours > hoursPerDay) {
      throw new Error(`Frånvarotimmar stämmer inte med arbetsschemat: ${day.absence_date}`)
    }
  }
  const { monthlySalary, payrollConfig, periodDays } = input
  const lineItems: DerivedLineItem[] = []
  const r = (x: number) => Math.round(x * 100) / 100

  const periodSickDates = periodDays
    .filter(d => d.absence_type === 'sick' && d.hours > 0)
    .map(d => d.absence_date)
    .sort()
  const vabDays = periodDays.filter(d => d.absence_type === 'vab')
  const parentalDays = periodDays.filter(d => d.absence_type === 'parental')
  const unpaidLeaveDays = periodDays.filter(d => d.absence_type === 'unpaid_leave')
  const calendarPolicy = input.calculationPolicy?.long_leave === 'calendar_after_five_workdays'
  if (calendarPolicy && ((input.workdaysPerWeek ?? 5) !== 5 || !input.periodStart || !input.periodEnd)) {
    throw new Error('Kalenderdagsavdrag kräver femdagarsschema och fullständig avvikelseperiod')
  }
  const calendarDeduction = (type: AbsenceType) => calendarLeaveDeduction({
    monthlySalary, hoursPerDay, dailyDivisor: input.dailyDivisor ?? 21,
    periodStart: input.periodStart!, periodEnd: input.periodEnd!,
    days: [...(input.contextDays ?? []), ...periodDays].filter(d => d.absence_type === type &&
      (input.calculationPolicy?.leave_context !== 'through_deviation_end' || d.absence_date <= input.periodEnd!)),
  })

  let flagFkReporting = false
  let flagLakarintyg = false

  if (periodSickDates.length > 0) {
    const periodMin = periodSickDates[0]

    // Build segments over (lookback ∪ period). Segments may straddle the
    // boundary; we need the full picture to classify each period day's
    // index within its segment.
    const allSickDates = [...input.lookbackSickDates, ...periodSickDates]
    const segments = buildSjukloneperioder(allSickDates)

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
    // reading produces complaints in the field.
    const cap = payrollConfig.maxKarensavdragPerYear ?? 10
    const cutoff = addDays(periodMin, -365)
    const lookbackOnlySegments = buildSjukloneperioder(
      input.lookbackSickDates.filter(d => d >= cutoff),
    )
    // Cutover adjustment: karens periods from the previous payroll system
    // that were never imported as day rows. Over-suppression of karens is
    // the softer error (consistent with the period-count reading above).
    let karensInWindow = lookbackOnlySegments.length + (input.karensPeriodsAdjustment ?? 0)

    // weeklyRate stays monthly x 12/52 by construction (schedule-independent);
    // only the DAILY rate scales with the workday schedule.
    const dailyRate = r(monthlySalary / (input.dailyDivisor ?? 21))
    const annualHourly = input.calculationPolicy?.sick_rate === 'annual_hourly'
    const hourlyRate = r(monthlySalary * 12 / (52 * (input.hoursPerWeek ?? hoursPerDay * 5)))
    const sickHourlyRate = r(hourlyRate * payrollConfig.sjuklonRate)
    const sickPay = (hours: number) => annualHourly
      ? r(sickHourlyRate * hours)
      : r(dailyRate * payrollConfig.sjuklonRate * hours / hoursPerDay)
    const weeklyRate = r(monthlySalary * 12 / 52 * payrollConfig.sjuklonRate)
    const karensAmount = r(weeklyRate * payrollConfig.karensavdragFactor)

    let day2_14CountTotal = 0
    let day15PlusCountTotal = 0

    // Walk each segment that touches the period.
    for (const seg of segments) {
      // Skip segments that don't touch the period at all.
      if (seg.endDate < periodMin) continue
      if (seg.startDate > periodSickDates[periodSickDates.length - 1]) continue

      const segmentStartsInPeriod = seg.startDate >= periodMin
      const eligiblePeriodDays = periodDays.filter(d => d.absence_type === 'sick' &&
        d.absence_date >= seg.startDate && d.absence_date <= seg.endDate &&
        daysBetweenIso(seg.startDate, d.absence_date) < 14)
      const eligibleHours = eligiblePeriodDays.reduce((sum, d) => sum + d.hours, 0)
      // Day one also receives sick pay. Karens can never exceed the sick pay
      // available in the episode; a short first day may carry into next month.
      const priorDays = input.lookbackSickDays ?? input.lookbackSickDates.map(absence_date =>
        ({ absence_date, absence_type: 'sick' as const, hours: hoursPerDay }))
      const priorHours = priorDays.filter(d => d.absence_date >= seg.startDate &&
        d.absence_date < periodMin && daysBetweenIso(seg.startDate, d.absence_date) < 14)
        .reduce((sum, d) => sum + d.hours, 0)
      const priorSickPay = sickPay(priorHours)
      const availableSickPay = sickPay(eligibleHours)
      const priorEpisodeIndex = lookbackOnlySegments.findIndex(s => s.startDate === seg.startDate)
      const karensEligible = segmentStartsInPeriod
        ? karensInWindow < cap
        : priorEpisodeIndex >= 0 && priorEpisodeIndex + (input.karensPeriodsAdjustment ?? 0) < cap
      const currentKarens = r(Math.min(Math.max(0, karensAmount - priorSickPay), availableSickPay))
      if (karensEligible && currentKarens > 0) {
          lineItems.push({
            item_type: 'sick_karens',
            description: `Karensavdrag (${seg.startDate})`,
            quantity: 1,
            amount: -currentKarens,
            is_taxable: true,
            is_avgift_basis: true,
            is_vacation_basis: false,
            is_gross_deduction: false,
          })
      }
      if (segmentStartsInPeriod) karensInWindow += 1

      // Classify each *period* sick day in this segment by its segment day
      // index (calendar days from segment start, 1-based).
      for (const d of periodSickDates) {
        if (d < seg.startDate || d > seg.endDate) continue
        const segDayIndex = daysBetweenIso(seg.startDate, d) + 1
        const equivalentDays = periodDays.filter(row => row.absence_type === 'sick' && row.absence_date === d)
          .reduce((sum, row) => sum + row.hours / hoursPerDay, 0)
        if (segDayIndex <= 14) {
          day2_14CountTotal += equivalentDays
          if (segDayIndex >= 8) flagLakarintyg = true
        } else if (segDayIndex >= 15) {
          day15PlusCountTotal += equivalentDays
          flagFkReporting = true
        }
      }
    }

    if (day2_14CountTotal > 0) {
      const lostPay = annualHourly ? r(hourlyRate * day2_14CountTotal * hoursPerDay) : r(dailyRate * day2_14CountTotal)
      const sjuklon = sickPay(day2_14CountTotal * hoursPerDay)
      lineItems.push({
        item_type: 'sick_day2_14',
        description: `Sjukavdrag efter sjuklön dag 1-14 (${r(day2_14CountTotal)} dagar)`,
        quantity: day2_14CountTotal,
        // Net deduction vs full pay = lostPay - sjuklon (employer pays 80%).
        amount: -r(lostPay - sjuklon),
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: false,
      })
    }

    if (day15PlusCountTotal > 0) {
      // Keep the FK phase separate even when a later, new episode has
      // employer-paid sick days in the same payroll month.
      const allRows = new Map([...(input.lookbackSickDays ?? []), ...(input.contextDays ?? []), ...periodDays]
        .filter(d => d.absence_type === 'sick').map(d => [d.absence_date, d]))
      const longRows = [...allRows.values()].filter(d => segments.some(seg =>
        d.absence_date >= seg.startDate && d.absence_date <= seg.endDate && daysBetweenIso(seg.startDate, d.absence_date) >= 14))
      const lostPay = calendarPolicy ? calendarLeaveDeduction({
        monthlySalary, hoursPerDay, dailyDivisor: input.dailyDivisor ?? 21,
        periodStart: input.periodStart!, periodEnd: input.periodEnd!, days: longRows,
        calendarFromStart: true,
      }) : r(dailyRate * day15PlusCountTotal)
      lineItems.push({
        item_type: 'sick_day15_plus',
        description: `Sjukfrånvaro dag 15+ (FK) (${day15PlusCountTotal} dagar)`,
        quantity: day15PlusCountTotal,
        // Employer pays nothing: full daily rate deducted.
        amount: -lostPay,
        is_taxable: true,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
      })
    }
  }

  // ── VAB ────────────────────────────────────────────────────────────────
  const vabCount = vabDays.length
  if (vabCount > 0) {
    const equivalentDays = vabDays.reduce((sum, day) => sum + day.hours / hoursPerDay, 0)
    const vab = calculateVabDeduction(monthlySalary, equivalentDays, input.vabDaysYtd, input.dailyDivisor)
    lineItems.push({
      item_type: 'vab',
      description: `VAB (${vabCount} dagar)`,
      quantity: equivalentDays,
      amount: -vab.deduction,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: vab.semesterGrundande,
      is_gross_deduction: false,
    })
  }

  // ── Parental leave ─────────────────────────────────────────────────────
  const parentalCount = parentalDays.length
  if (parentalCount > 0) {
    const equivalentDays = parentalDays.reduce((sum, day) => sum + day.hours / hoursPerDay, 0)
    const parental = calculateParentalLeaveDeduction(
      monthlySalary,
      equivalentDays,
      input.parentalDaysPregnancyYtd,
      input.dailyDivisor,
    )
    lineItems.push({
      item_type: 'parental_leave',
      description: `Föräldraledighet (${parentalCount} dagar)`,
      quantity: equivalentDays,
      amount: -(calendarPolicy ? calendarDeduction('parental') : parental.deduction),
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: parental.semesterGrundande,
      is_gross_deduction: false,
    })
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
    const equivalentDays = unpaidLeaveDays.reduce((sum, day) => sum + day.hours / hoursPerDay, 0)
    const deduction = calendarPolicy ? calendarDeduction('unpaid_leave') : r(dailyRate * equivalentDays)
    lineItems.push({
      item_type: 'unpaid_leave',
      description: `Tjänstledighet utan lön (${unpaidLeaveCount} dagar)`,
      quantity: equivalentDays,
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
  hoursPerDay?: number
  hoursPerWeek?: number
  workdaysPerWeek?: number
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
  let contextDays: AbsenceDay[] = []
  if (params.calculationPolicy?.long_leave === 'calendar_after_five_workdays') {
    const { data, error } = await supabase.from('salary_absence_days')
      .select('absence_date, absence_type, hours')
      .eq('company_id', companyId).eq('employee_id', employeeId)
      .gte('absence_date', addDays(periodStart, -31)).lte('absence_date', addDays(periodEnd, 31))
    if (error) throw new Error(`Kunde inte läsa frånvaroperioder: ${error.message}`)
    contextDays = ((data ?? []) as AbsenceDay[]).filter(d => d.absence_date < periodStart || d.absence_date > periodEnd)
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
  const lookbackSickDates = (lookbackRows ?? []).map(r => r.absence_date as string)

  const yearStart = `${periodStart.slice(0, 4)}-01-01`
  const { data: vabYtd, error: vabError } = await supabase
    .from('salary_absence_days')
    .select('absence_date')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('absence_type', 'vab')
    .gte('absence_date', yearStart)
    .lt('absence_date', periodStart)
  const vabDaysYtd = vabYtd?.length ?? 0
  if (vabError) throw new Error(`Kunde inte läsa tidigare VAB: ${vabError.message}`)

  const { data: parentalYtd, error: parentalError } = await supabase
    .from('salary_absence_days')
    .select('absence_date')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('absence_type', 'parental')
    .gte('absence_date', yearStart)
    .lt('absence_date', periodStart)
  const parentalDaysPregnancyYtd = parentalYtd?.length ?? 0
  if (parentalError) throw new Error(`Kunde inte läsa tidigare föräldraledighet: ${parentalError.message}`)

  return deriveAbsenceLineItems({
    monthlySalary: params.monthlySalary,
    payrollConfig: params.payrollConfig,
    periodDays,
    lookbackSickDates,
    lookbackSickDays: (lookbackRows ?? []) as AbsenceDay[],
    vabDaysYtd,
    parentalDaysPregnancyYtd,
    karensPeriodsAdjustment: params.karensPeriodsAdjustment,
    dailyDivisor: params.dailyDivisor,
    hoursPerDay: params.hoursPerDay,
    hoursPerWeek: params.hoursPerWeek,
    workdaysPerWeek: params.workdaysPerWeek,
    calculationPolicy: params.calculationPolicy,
    contextDays, periodStart, periodEnd,
  })
}
