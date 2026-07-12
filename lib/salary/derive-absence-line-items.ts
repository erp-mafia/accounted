import type { SupabaseClient } from '@supabase/supabase-js'
import type { PayrollConfig } from './payroll-config'
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
 *     Day 1 is karensavdrag (one per period). Days 2-14 are sjuklön at 80%.
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

function daysBetween(a: string, b: string): number {
  return Math.round((dateOnly(b).getTime() - dateOnly(a).getTime()) / ONE_DAY_MS)
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
    const gap = daysBetween(endDate, date)
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
  /** Year-to-date VAB days for this employee, excluding the current period. */
  vabDaysYtd: number
  /** Parental leave days in the current pregnancy window (best-effort:
   *  defaults to calendar-year aggregate). */
  parentalDaysPregnancyYtd: number
}

export function deriveAbsenceLineItems(input: DeriveInput): DeriveResult {
  const { monthlySalary, payrollConfig, periodDays } = input
  const lineItems: DerivedLineItem[] = []
  const r = (x: number) => Math.round(x * 100) / 100

  const periodSickDates = periodDays
    .filter(d => d.absence_type === 'sick')
    .map(d => d.absence_date)
  const vabDays = periodDays.filter(d => d.absence_type === 'vab')
  const parentalDays = periodDays.filter(d => d.absence_type === 'parental')
  const unpaidLeaveDays = periodDays.filter(d => d.absence_type === 'unpaid_leave')

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
    let karensInWindow = lookbackOnlySegments.length

    const dailyRate = r(monthlySalary / 21)
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

      // Karens for the segment? Day 1 of segment, only if it starts in this
      // period and the högriskskydd cap isn't hit. (If the segment started
      // in a prior pay period, the karens was already booked there; nothing
      // to emit here.)
      if (segmentStartsInPeriod) {
        if (karensInWindow < cap) {
          lineItems.push({
            item_type: 'sick_karens',
            description: `Karensavdrag (${seg.startDate})`,
            quantity: 1,
            amount: -karensAmount,
            is_taxable: true,
            is_avgift_basis: true,
            is_vacation_basis: false,
            is_gross_deduction: true,
          })
          karensInWindow += 1
        } else {
          // Suppressed by allmänt högriskskydd. The employee keeps day-1 pay
          // (no karens deduction). Day 1 still consumed from the 14-day
          // window but treated as paid normal: emit nothing for it.
        }
      }

      // Classify each *period* sick day in this segment by its segment day
      // index (calendar days from segment start, 1-based).
      for (const d of periodSickDates) {
        if (d < seg.startDate || d > seg.endDate) continue
        const segDayIndex = daysBetween(seg.startDate, d) + 1
        if (segDayIndex === 1 && segmentStartsInPeriod) {
          // already accounted for as karens (or suppressed); skip
          continue
        }
        if (segDayIndex >= 2 && segDayIndex <= 14) {
          day2_14CountTotal += 1
          if (segDayIndex >= 8) flagLakarintyg = true
        } else if (segDayIndex >= 15) {
          day15PlusCountTotal += 1
          flagFkReporting = true
        }
      }
    }

    if (day2_14CountTotal > 0) {
      const lostPay = r(dailyRate * day2_14CountTotal)
      const sjuklon = r(dailyRate * payrollConfig.sjuklonRate * day2_14CountTotal)
      lineItems.push({
        item_type: 'sick_day2_14',
        description: `Sjuklön dag 2-14 (${day2_14CountTotal} dagar)`,
        quantity: day2_14CountTotal,
        // Net deduction vs full pay = lostPay - sjuklon (employer pays 80%).
        amount: -(lostPay - sjuklon),
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: true,
      })
    }

    if (day15PlusCountTotal > 0) {
      const lostPay = r(dailyRate * day15PlusCountTotal)
      lineItems.push({
        item_type: 'sick_day15_plus',
        description: `Sjukfrånvaro dag 15+ (FK) (${day15PlusCountTotal} dagar)`,
        quantity: day15PlusCountTotal,
        // Employer pays nothing: full daily rate deducted.
        amount: -lostPay,
        is_taxable: true,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: true,
      })
    }
  }

  // ── VAB ────────────────────────────────────────────────────────────────
  const vabCount = vabDays.length
  if (vabCount > 0) {
    const vab = calculateVabDeduction(monthlySalary, vabCount, input.vabDaysYtd)
    lineItems.push({
      item_type: 'vab',
      description: `VAB (${vabCount} dagar)`,
      quantity: vabCount,
      amount: -vab.deduction,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: vab.semesterGrundande,
      is_gross_deduction: true,
    })
  }

  // ── Parental leave ─────────────────────────────────────────────────────
  const parentalCount = parentalDays.length
  if (parentalCount > 0) {
    const parental = calculateParentalLeaveDeduction(
      monthlySalary,
      parentalCount,
      input.parentalDaysPregnancyYtd,
    )
    lineItems.push({
      item_type: 'parental_leave',
      description: `Föräldraledighet (${parentalCount} dagar)`,
      quantity: parentalCount,
      amount: -parental.deduction,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: parental.semesterGrundande,
      is_gross_deduction: true,
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
    const dailyRate = r(monthlySalary / 21)
    const deduction = r(dailyRate * unpaidLeaveCount)
    lineItems.push({
      item_type: 'unpaid_leave',
      description: `Tjänstledighet utan lön (${unpaidLeaveCount} dagar)`,
      quantity: unpaidLeaveCount,
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

  const lookbackStart = addDays(periodStart, -365)
  const { data: lookbackRows, error: lookbackErr } = await supabase
    .from('salary_absence_days')
    .select('absence_date')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('absence_type', 'sick')
    .gte('absence_date', lookbackStart)
    .lt('absence_date', periodStart)
  if (lookbackErr) throw new Error(`Failed to load absence lookback: ${lookbackErr.message}`)
  const lookbackSickDates = (lookbackRows ?? []).map(r => r.absence_date as string)

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
    vabDaysYtd,
    parentalDaysPregnancyYtd,
  })
}
