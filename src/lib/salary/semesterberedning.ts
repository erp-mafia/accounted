/**
 * Semesterberedning + semesterårsavslut (payroll gap-closure 3.3).
 *
 * ONE workflow, two phases on the same year boundary:
 *
 *   Beredning (days): per employee, roll the closing year's balances into
 *   the next vacation year. Only days above the 20-day must-take floor are
 *   saveable (Semesterlagen 18 §); saved days expire after 5 years and move
 *   to forced_payout_days (paid out as semesterersättning via a normal
 *   salary run, never booked here). Untaken days at or below the floor are
 *   FLAGGED for manual handling, not auto-saved.
 *
 *   Årsavslut (SEK): reconcile the day-valued semesterlöneskuld against the
 *   BOOKED 2920/2940 balances (per-run accruals never relieve 2920 when
 *   vacation is taken, so drift accumulates by design) and post ONE
 *   adjustment verifikation via the bookkeeping engine when |drift| > 1 kr,
 *   through the posting port (kind payroll.vacation_liability_adjusted).
 *
 * Day valuation (BFNAR 2016:10 per-employee, simplified and shown in the
 * review report before anything commits):
 *   sammalöneregeln (monthly): monthly/dailyDivisor + monthly x tillägg, or
 *                              monthly x 4,6 % + monthly x tillägg under the
 *                              vacation_day_value policy percent_4_6
 *   procentregeln            : the earning year's day value (rate x the
 *                              intjänandeår's semesterlönegrundande lön /
 *                              earned days, 16 b §, procentregeln-liability.ts;
 *                              on the calendar basis, where the employee was
 *                              not employed the whole previous year, the
 *                              running year's semesterlön so far over the days
 *                              it earned), and only where Accounted lacks the
 *                              pay the estimate below
 *   procentregeln estimate   : monthly x 12 x rate / days per year, or
 *                              hourly x hours_per_week x 52 x rate / days per
 *                              year (a full year's day; a mid-year hire's days
 *                              are fewer, Semesterlagen 7 §)
 * The days valued are vacationLiabilityDays' (vacation-liability-days.ts):
 * the year's untaken paid days, the sparade dagar and, on the statutory
 * basis, the next semesterår's days earned in the closing intjänandeår. The
 * Semesterskuld report and the remeasurement value the same days, so a
 * company that books the liability at every run finds next to no drift here.
 * Under sammalöneregeln the liability also carries the semesterlön of the
 * rörliga lönedelar still unpaid at the year end (Semesterlagen 16 a §
 * tredje stycket, lib/salary/variable-vacation-pay.ts): it is paid after the
 * semesterår, not per day, so it is a sum per employee, not a day value.
 * Avgifter on the liability use per-employee age tiers at the settlement
 * year (liabilityAvgifterRate: born <= 1937 exempt, fyllt 67 vid årets
 * ingång 10.21%, otherwise 31.42%), matching the rates the per-run accruals
 * booked on 2940. The temporary youth discount is deliberately NOT
 * provisioned (see liabilityAvgifterRate); youth accruals therefore show a
 * top-up drift.
 *
 * The frozen report is stored on vacation_year_closures (BFL 7 kap: it is
 * the underlag for the adjustment entry). The UNIQUE
 * (company_id, vacation_year_start) makes replays a clean conflict.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre, sumOre } from '@/lib/money'
import { dailyDivisor, degreeAdjustedMonthlySalary } from './work-schedule'
import { paidDaysPerDayOff } from './vacation-net-days'
import { resolveVacationPayRate } from './vacation-pay-rate'
import { loadVariablePayRuns, previousVacationYearStart, unpaidVariableVacationPayAtYearEnd } from './variable-vacation-pay'
import { getVacationYearBounds, type VacationYearBasis } from './vacation-year'
import { computeEntitledDays, getVacationYearBasis, syncVacationLedgerForEmployees, type VacationBalanceRow } from './vacation-ledger'
import { remainingSavedDays } from './vacation-category'
import {
  liabilityAvgifterRate,
  liabilitySettlementYear,
  vacationLiabilityDays,
  type VacationLiabilityDays,
} from './vacation-liability-days'
import { loadProcentregelnLiabilityValues, procentregelnLiabilitySek } from './procentregeln-liability'
import { DRIFT_TOLERANCE_SEK } from './vacation-liability-plan'
import { vacationDayValuePolicyFrom, type VacationDayValuePolicy } from './calculation-policy'
import {
  splitVacationLiabilityChange,
  vacationLiabilityChangeAccount,
  type VacationLiabilityChangeAccount,
} from './account-mapping'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { categoryForTemplateGroup } from '@/lib/posting/categories'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'

/** Sammalöneregeln day value under vacation_day_value percent_4_6 (K2 exempel 17 b). */
const PERCENT_4_6_DAY_SHARE = 0.046

export type VacationCloseResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

export interface VacationCloseEmployeeRow {
  employee_id: string
  employee_name: string
  vacation_rule: string
  entitled_days: number
  taken_days: number
  remaining_days: number
  /** Days above the 20-day must-take floor: rolled into saved_days. */
  saveable_days: number
  /** Untaken days at/below the floor: flagged for manual handling. */
  untaken_below_floor_days: number
  /** Saved days whose origin year fell out of the 5-year window: forced payout. */
  expiring_days: number
  /** Statutory basis: the next semesterår's paid days earned in the closing
   *  intjänandeår, owed at the year end and part of the liability. 0 under
   *  the calendar basis, where they are earned in the year they are taken. */
  earning_days?: number
  /** Obetalda days still unused at close: they lapse (Semesterlagen 8 §), never carry. */
  unpaid_days_lapsed: number
  /** Förskott days taken during the closing year: they reduce next year's
   *  entitlement; the förskottsskuld itself stays on the opening row. */
  advance_days_taken: number
  saved_days_before: Record<string, number>
  saved_days_after: Record<string, number>
  next_year_entitled: number
  day_value_sek: number
  /** Sammalöneregeln: semesterlön of the rörliga lönedelar still unpaid at
   *  the year end (Semesterlagen 16 a § tredje stycket), included in
   *  computed_liability_sek; 0 for everyone else. */
  variable_vacation_pay_sek: number
  computed_liability_sek: number
  /** Age-tier avgifter rate applied to this employee's liability for the
   * 2940 target (0 exempt, 0.1021 fyllt 67, 0.3142 standard). */
  avgifter_rate: number
  /** Where this employee's share of a 2920 drift adjustment books: 7090
   * arbetare, 7290 everyone else (vacationLiabilityChangeAccount). */
  liability_change_account: VacationLiabilityChangeAccount
}

export interface VacationCloseReport {
  vacation_year_start: string
  vacation_year_end: string
  next_year_start: string
  basis: VacationYearBasis
  rows: VacationCloseEmployeeRow[]
  sek: {
    computed_liability: number
    computed_avgifter: number
    booked_2920: number
    booked_2940: number
    drift_2920: number
    drift_2940: number
    adjustment_needed: boolean
  }
  adjustment_date: string
}

interface EmployeeRosterRow {
  id: string
  first_name: string
  last_name: string
  employment_type: string
  personnel_category: string | null
  personnummer: string | null
  vacation_rule: string
  vacation_days_per_year: number
  vacation_pay_rate: number | null
  semestertillagg_rate: number | null
  salary_type: string
  /** Full-time salary; the pay earned is this x employment_degree / 100. */
  monthly_salary: number | null
  employment_degree: number | null
  hourly_rate: number | null
  hours_per_week: number | null
  workdays_per_week: number | null
  employment_start: string
  employment_end: string | null
}

function lastDayBefore(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** The employee master fields the day valuation reads. */
export type DayValueEmployee = Pick<
  EmployeeRosterRow,
  | 'vacation_rule'
  | 'vacation_days_per_year'
  | 'vacation_pay_rate'
  | 'salary_type'
  | 'monthly_salary'
  | 'employment_degree'
  | 'hourly_rate'
  | 'hours_per_week'
  | 'workdays_per_week'
> & {
  /** Sammalöneregeln tillägg per day; absent or null = statutory 0.43 %. */
  semestertillagg_rate?: number | null
}

/**
 * Simplified BFNAR 2016:10 value of one paid vacation day in SEK (the unit
 * the ledger counts, vacation-net-days.ts), from the employee's pay today.
 * Under procentregeln this is only the estimate: the valuations price a day
 * from the earning year's pay (procentregeln-liability.ts, Semesterlagen
 * 16 b §) and fall back here where Accounted lacks that year. Shared by the year-close, the
 * Semesterskuld report, the remeasurement, the MCP vacation-balance tool and
 * the v1 vacation-balance route, so all of them agree on the
 * semesterlöneskuld estimate and a kollektivavtal semesterlön rate
 * (employees.vacation_pay_rate) reaches every one of them. `dayValuePolicy`
 * is the company's vacation_day_value convention (calculation-policy.ts); it
 * only changes the sammalöneregeln dagslön.
 */
export function dayValueSek(emp: DayValueEmployee, dayValuePolicy: VacationDayValuePolicy = 'daily_divisor'): number {
  const rate = resolveVacationPayRate(emp.vacation_days_per_year, emp.vacation_pay_rate)
  if (emp.salary_type === 'hourly') {
    const annualBasis = (emp.hourly_rate || 0) * (emp.hours_per_week ?? 40) * 52
    return roundOre((annualBasis * rate) / Math.max(emp.vacation_days_per_year, 1))
  }
  // monthly_salary is the full-time salary; a part-timer's vacation day is
  // worth a day of the pay they actually earn.
  const monthly = degreeAdjustedMonthlySalary(emp.monthly_salary, emp.employment_degree)
  if (emp.vacation_rule === 'sammaloneregeln') {
    // Dagslön + semestertillägg per paid day at the employee's configured
    // rate (many CBAs use 0.8 %); the statutory floor 0.43 % when absent. The
    // salary keeps running per day off, and on a short week a day off uses
    // more than one paid day (25 paid days are 20 days off at four days a
    // week), so the dagslön is spread over the paid days it covers. The
    // tillägg is per paid day as it stands (Semesterlagen 16 a §).
    const tillagg = emp.semestertillagg_rate ?? 0.0043
    // percent_4_6: 4,6 % of the månadslön per paid day, schedule-independent
    // (25 paid days are 115 % of a month whatever the week looks like).
    if (dayValuePolicy === 'percent_4_6') return roundOre(monthly * PERCENT_4_6_DAY_SHARE + monthly * tillagg)
    const perDayOff = paidDaysPerDayOff(emp.vacation_days_per_year, emp.workdays_per_week)
    return roundOre(monthly / dailyDivisor(emp.workdays_per_week) / perDayOff + monthly * tillagg)
  }
  return roundOre((monthly * 12 * rate) / Math.max(emp.vacation_days_per_year, 1))
}

/**
 * The new semesterår's paid days (Semesterlagen 7 §, computeEntitledDays: the
 * days its intjänandeår earns, rounded up); none when the employment ended
 * before the new year begins.
 */
function nextYearEntitled(emp: EmployeeRosterRow, basis: VacationYearBasis, newYearStart: string): number {
  if (emp.employment_end && emp.employment_end < newYearStart) return 0
  return computeEntitledDays(basis, newYearStart, emp.vacation_days_per_year, emp.employment_start, emp.employment_end)
}

async function loadRoster(
  supabase: SupabaseClient,
  companyId: string,
): Promise<VacationCloseResult<EmployeeRosterRow[]>> {
  const { data, error } = await supabase
    .from('employees')
    .select(
      'id, first_name, last_name, employment_type, personnel_category, personnummer, vacation_rule, vacation_days_per_year, vacation_pay_rate, semestertillagg_rate, salary_type, monthly_salary, employment_degree, hourly_rate, hours_per_week, workdays_per_week, employment_start, employment_end',
    )
    .eq('company_id', companyId)
    .eq('is_active', true)
    .not('vacation_rule', 'in', '(none,semesterersattning)')
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  return { ok: true, data: (data ?? []) as unknown as EmployeeRosterRow[] }
}

/** Booked 2920/2940 (credit-normal) as of a date, from the covering fiscal period. */
export async function bookedVacationBalances(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<VacationCloseResult<{ booked2920: number; booked2940: number }>> {
  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .lte('period_start', asOfDate)
    .gte('period_end', asOfDate)
    .maybeSingle()
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  if (!period) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: `Ingen räkenskapsperiod täcker ${asOfDate}.` },
    }
  }

  const tb = await generateTrialBalance(supabase, companyId, (period as { id: string }).id, {
    // Reads 29xx semesterlöneskuld accounts (class 2).
    closingEntry: 'include',
    toDate: asOfDate,
  })
  const balanceOf = (account: string): number => {
    const row = tb.rows.find((r) => r.account_number === account)
    if (!row) return 0
    // 2920/2940 are credit-normal liabilities.
    return roundOre(row.closing_credit - row.closing_debit)
  }
  return { ok: true, data: { booked2920: balanceOf('2920'), booked2940: balanceOf('2940') } }
}

export async function previewVacationYearClose(
  supabase: SupabaseClient,
  companyId: string,
  closingYearStart: string,
): Promise<VacationCloseResult<VacationCloseReport>> {
  const basis = await getVacationYearBasis(supabase, companyId)
  const bounds = getVacationYearBounds(closingYearStart)
  const yearEnd = lastDayBefore(bounds.end)
  const newYearStart = bounds.end

  // A year can only be closed once it has ended.
  const today = todayIsoStockholm()
  if (today < bounds.end) {
    return {
      ok: false,
      code: 'VACATION_YEAR_NOT_ENDED',
      details: { vacation_year_start: closingYearStart, vacation_year_end: yearEnd },
    }
  }

  // Replay guard for previews too: a closed year has a frozen report already.
  const { data: existingClosure } = await supabase
    .from('vacation_year_closures')
    .select('id')
    .eq('company_id', companyId)
    .eq('vacation_year_start', closingYearStart)
    .maybeSingle()
  if (existingClosure) {
    return {
      ok: false,
      code: 'VACATION_YEAR_ALREADY_CLOSED',
      details: { vacation_year_start: closingYearStart },
    }
  }

  const roster = await loadRoster(supabase, companyId)
  if (!roster.ok) return roster

  // Make sure the closing year's ledger rows exist and are recomputed as of
  // the year end (seeds from cutover/legacy data on first touch).
  const sync = await syncVacationLedgerForEmployees(
    supabase,
    companyId,
    roster.data.map((e) => e.id),
    yearEnd,
  )
  if (!sync.ok) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: sync.message } }
  }

  const { data: ledgerRows, error: ledgerErr } = await supabase
    .from('employee_vacation_balances')
    .select(
      'id, employee_id, vacation_year_start, entitled_days, accrued_days, taken_days, saved_days, forced_payout_days, status, unpaid_days, advance_days, saved_days_taken',
    )
    .eq('company_id', companyId)
    .eq('vacation_year_start', closingYearStart)
  if (ledgerErr) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: ledgerErr.message } }
  }
  const ledgerByEmployee = new Map(
    ((ledgerRows ?? []) as unknown as VacationBalanceRow[]).map((r) => [r.employee_id, r]),
  )

  // Cutover pools: förskott days taken during the closing year are the
  // imported pool minus what the ledger still holds, and only the year that
  // contains cutover_date ever seeded that pool.
  const { data: openingRows, error: openingErr } = await supabase
    .from('employee_opening_balances')
    .select('employee_id, cutover_date, vacation_advance_days_remaining')
    .eq('company_id', companyId)
  if (openingErr) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: openingErr.message } }
  }
  const openingByEmployee = new Map(
    ((openingRows ?? []) as Array<{
      employee_id: string
      cutover_date: string
      vacation_advance_days_remaining: number | null
    }>).map((o) => [o.employee_id, o]),
  )

  // Sammalöneregeln: the payslips that carry the rörliga lönedelar of the
  // closing year and the year before it (lib/salary/variable-vacation-pay.ts).
  const sammaloneIds = roster.data.filter((e) => e.vacation_rule === 'sammaloneregeln').map((e) => e.id)
  let variablePayRuns: Awaited<ReturnType<typeof loadVariablePayRuns>>
  try {
    variablePayRuns = await loadVariablePayRuns(supabase, {
      companyId,
      employeeIds: sammaloneIds,
      from: previousVacationYearStart(closingYearStart),
      to: bounds.end,
    })
  } catch (err) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: err instanceof Error ? err.message : 'unknown' } }
  }

  const closingYear = Number(closingYearStart.slice(0, 4))
  // The rolled liability is paid out during the new vacation year: that is
  // the year the avgifter age tier is evaluated against (the day after the
  // year end, liabilitySettlementYear).
  const settlementYear = liabilitySettlementYear(yearEnd)
  // Everything but the SEK value, which waits for the day-value policy.
  const pending: Array<{
    emp: EmployeeRosterRow
    days: VacationLiabilityDays
    row: Omit<VacationCloseEmployeeRow, 'day_value_sek' | 'computed_liability_sek' | 'avgifter_rate'>
  }> = []

  for (const emp of roster.data) {
    const ledger = ledgerByEmployee.get(emp.id)
    const entitled =
      ledger?.entitled_days ?? computeEntitledDays(basis, closingYearStart, emp.vacation_days_per_year, emp.employment_start)
    const taken = ledger?.taken_days ?? 0
    // Sparade dagar still held: the seeded years minus what 'saved' vacation
    // lines consumed during the year.
    const savedBefore = remainingSavedDays(
      (ledger?.saved_days ?? {}) as Record<string, number>,
      ledger?.saved_days_taken ?? {},
    )
    const remaining = Math.max(0, roundOre(entitled - taken))

    const opening = openingByEmployee.get(emp.id)
    const cutoverInClosingYear =
      !!opening && opening.cutover_date >= closingYearStart && opening.cutover_date < bounds.end
    const advanceSeed = cutoverInClosingYear ? (opening.vacation_advance_days_remaining || 0) : 0
    const advanceTaken = ledger
      ? Math.max(0, roundOre(advanceSeed - (ledger.advance_days ?? advanceSeed)))
      : 0
    const unpaidLapsed = ledger?.unpaid_days ?? 0

    // Semesterlagen 18 §: only days exceeding the 20-day floor are saveable.
    const saveable = Math.max(0, Math.min(remaining, entitled - 20))
    const untakenBelowFloor = roundOre(remaining - saveable)

    // 5-year expiry: a day saved in origin year X is takeable through X + 5.
    // Rolling into the new year, origins <= closingYear - 5 fall out.
    let expiring = 0
    const savedAfter: Record<string, number> = {}
    for (const [originYear, days] of Object.entries(savedBefore)) {
      const numDays = Number(days) || 0
      if (numDays <= 0) continue
      if (Number(originYear) <= closingYear - 5) {
        expiring = roundOre(expiring + numDays)
      } else {
        savedAfter[originYear] = numDays
      }
    }
    if (saveable > 0) {
      savedAfter[String(closingYear)] = roundOre((savedAfter[String(closingYear)] ?? 0) + saveable)
    }

    // The liability covers everything still owed: this year's untaken days
    // (incl. the below-floor flag) + all saved days + expiring days awaiting
    // payout, and on the statutory basis the next year's days earned in the
    // closing intjänandeår (vacationLiabilityDays, shared with the report and
    // the remeasurement).
    const days = vacationLiabilityDays({
      basis,
      yearStart: closingYearStart,
      asOfDate: yearEnd,
      entitledDays: entitled,
      takenDays: taken,
      savedDays: Object.values(savedBefore).reduce((s, d) => s + (Number(d) || 0), 0),
      vacationDaysPerYear: emp.vacation_days_per_year,
      employmentStart: emp.employment_start,
      employmentEnd: emp.employment_end,
    })
    const variableVacationPay =
      emp.vacation_rule === 'sammaloneregeln'
        ? unpaidVariableVacationPayAtYearEnd({
            closingYearStart,
            rate: resolveVacationPayRate(emp.vacation_days_per_year, emp.vacation_pay_rate),
            runs: variablePayRuns.get(emp.id) ?? [],
          }).unpaid
        : 0

    pending.push({ emp, days, row: {
      employee_id: emp.id,
      employee_name: `${emp.first_name} ${emp.last_name}`,
      vacation_rule: emp.vacation_rule,
      entitled_days: entitled,
      taken_days: taken,
      remaining_days: remaining,
      saveable_days: saveable,
      untaken_below_floor_days: untakenBelowFloor,
      expiring_days: expiring,
      unpaid_days_lapsed: unpaidLapsed,
      advance_days_taken: advanceTaken,
      saved_days_before: savedBefore,
      saved_days_after: savedAfter,
      // Förskott days taken this year were paid before they were earned:
      // they come off the new year's entitlement.
      next_year_entitled: Math.max(
        0,
        roundOre(nextYearEntitled(emp, basis, newYearStart) - advanceTaken),
      ),
      variable_vacation_pay_sek: variableVacationPay,
      ...(days.earning_days > 0 ? { earning_days: days.earning_days } : {}),
      liability_change_account: vacationLiabilityChangeAccount({
        employmentType: emp.employment_type,
        personnelCategory: emp.personnel_category,
      }),
    } })
  }

  const booked = await bookedVacationBalances(supabase, companyId, yearEnd)
  if (!booked.ok) return booked

  // The company's day-value convention (calculation-policy.ts), read last:
  // it only prices the days counted above.
  const { data: policyRow } = await supabase
    .from('company_settings')
    .select('salary_calculation_policy')
    .eq('company_id', companyId)
    .maybeSingle()
  const dayValuePolicy = vacationDayValuePolicyFrom(
    (policyRow as { salary_calculation_policy?: unknown } | null)?.salary_calculation_policy,
  )

  // Procentregeln days are valued on the pay they were earned on (16 b §,
  // procentregeln-liability.ts), not today's salary; the estimate stands in
  // only where Accounted lacks the earning year.
  let procentValues: Awaited<ReturnType<typeof loadProcentregelnLiabilityValues>>
  try {
    procentValues = await loadProcentregelnLiabilityValues(supabase, {
      companyId,
      basis,
      asOfDate: yearEnd,
      employees: roster.data.filter((e) => e.vacation_rule === 'procentregeln'),
    })
  } catch (err) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: err instanceof Error ? err.message : 'unknown' } }
  }

  const rows: VacationCloseEmployeeRow[] = pending.map(({ emp, days, row }) => {
    const estimate = dayValueSek(emp, dayValuePolicy)
    const procent =
      emp.vacation_rule === 'procentregeln' ? procentregelnLiabilitySek(days, procentValues.get(emp.id), estimate) : null
    return {
      ...row,
      day_value_sek: procent ? procent.dayValue : estimate,
      computed_liability_sek: procent
        ? procent.liability
        : roundOre(days.total_days * estimate + row.variable_vacation_pay_sek),
      avgifter_rate: liabilityAvgifterRate(emp.personnummer, settlementYear),
    }
  })

  const computedLiability = sumOre(rows.map((r) => r.computed_liability_sek))
  const computedAvgifter = sumOre(
    rows.map((r) => roundOre(r.computed_liability_sek * r.avgifter_rate)),
  )

  const drift2920 = roundOre(computedLiability - booked.data.booked2920)
  const drift2940 = roundOre(computedAvgifter - booked.data.booked2940)

  return {
    ok: true,
    data: {
      vacation_year_start: closingYearStart,
      vacation_year_end: yearEnd,
      next_year_start: newYearStart,
      basis,
      rows,
      sek: {
        computed_liability: computedLiability,
        computed_avgifter: computedAvgifter,
        booked_2920: booked.data.booked2920,
        booked_2940: booked.data.booked2940,
        drift_2920: drift2920,
        drift_2940: drift2940,
        adjustment_needed:
          Math.abs(drift2920) > DRIFT_TOLERANCE_SEK || Math.abs(drift2940) > DRIFT_TOLERANCE_SEK,
      },
      adjustment_date: yearEnd,
    },
  }
}

/**
 * The business event of the semesterårsavslut's adjustment (kind
 * payroll.vacation_liability_adjusted), for the posting port: recorded while
 * POSTING_EVENTS is shadow or strict, never built while it is off. Pure.
 *
 * Dated the adjustment date (the closing vacation year's last day, the
 * verifikat date) and filed under expense.personnel like the salary run. No
 * subject: the closure row has no typed handle; the verifikat's source_id
 * names it. A close of one employee names that employee as party (type and
 * id only), one of several names none. No amount: the 2920 and 2940 drifts
 * can move in opposite directions, and a magnitude cannot say which way;
 * the lines carry both. Nothing per employee goes into the evidence.
 */
export function vacationYearCloseBusinessEvent(report: VacationCloseReport, linkBasis: LinkBasisColumns): BusinessEventDraft {
  const only = report.rows.length === 1 ? report.rows[0] : null
  return {
    kind: 'payroll.vacation_liability_adjusted',
    category: categoryForTemplateGroup('personnel'),
    occurredOn: report.adjustment_date,
    party: only ? { type: 'employee', id: only.employee_id } : null,
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('vacationYearClose'),
    jurisdiction: 'SE',
  }
}

export async function commitVacationYearClose(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  closingYearStart: string,
  options: { bookAdjustment: boolean },
): Promise<VacationCloseResult<{ closure_id: string; adjustment_entry_id: string | null; report: VacationCloseReport }>> {
  const preview = await previewVacationYearClose(supabase, companyId, closingYearStart)
  if (!preview.ok) return preview
  const report = preview.data

  // Period-lock pre-check BEFORE any writes so a locked bokslut period fails
  // the whole close cleanly (the DB trigger is the backstop).
  if (options.bookAdjustment && report.sek.adjustment_needed) {
    const { checkPeriodLock } = await import('@/lib/api/v1/check-period-lock')
    const lockVerdict = await checkPeriodLock(supabase, companyId, report.adjustment_date)
    if (lockVerdict.locked) {
      return {
        ok: false,
        code: 'PERIOD_LOCKED',
        details: {
          reason: lockVerdict.reason,
          fiscal_period_id: lockVerdict.fiscal_period_id,
          adjustment_date: report.adjustment_date,
        },
      }
    }
  }

  // 1. Closure row: the UNIQUE constraint is the replay anchor.
  const { data: closure, error: closureErr } = await supabase
    .from('vacation_year_closures')
    .insert({
      company_id: companyId,
      vacation_year_start: closingYearStart,
      closed_by: userId,
      report: report as unknown as Record<string, unknown>,
    })
    .select('id')
    .single()
  if (closureErr) {
    if (closureErr.code === '23505') {
      return {
        ok: false,
        code: 'VACATION_YEAR_ALREADY_CLOSED',
        details: { vacation_year_start: closingYearStart },
      }
    }
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: closureErr.message } }
  }
  const closureId = (closure as { id: string }).id

  // 2. Close the year's ledger rows.
  const { error: closeErr } = await supabase
    .from('employee_vacation_balances')
    .update({ status: 'closed' })
    .eq('company_id', companyId)
    .eq('vacation_year_start', closingYearStart)
  if (closeErr) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: closeErr.message } }
  }

  // 3. Next-year rows: entitlement + rolled saved days + forced payouts.
  //    Upsert MERGES over any lazy-seeded row; taken_days is recomputed by
  //    the sync below, so seeding it 0 here is safe.
  const nextRows = report.rows.map((row) => ({
    company_id: companyId,
    employee_id: row.employee_id,
    vacation_year_start: report.next_year_start,
    entitled_days: row.next_year_entitled,
    accrued_days: 0,
    taken_days: 0,
    saved_days: row.saved_days_after,
    forced_payout_days: row.expiring_days,
    status: 'open',
    // Unpaid days lapse, förskott was a cutover-only grant, and the new
    // year's saved seed starts unconsumed.
    unpaid_days: 0,
    advance_days: 0,
    saved_days_taken: {},
  }))
  if (nextRows.length > 0) {
    const { error: nextErr } = await supabase
      .from('employee_vacation_balances')
      .upsert(nextRows, { onConflict: 'company_id,employee_id,vacation_year_start' })
    if (nextErr) {
      return { ok: false, code: 'INTERNAL_ERROR', details: { message: nextErr.message } }
    }
  }

  // Recompute taken_days on the fresh rows from any already-booked runs in
  // the new year (non-fatal, same contract as the booking hook).
  await syncVacationLedgerForEmployees(
    supabase,
    companyId,
    report.rows.map((r) => r.employee_id),
  )

  // 4. Drift adjustment verifikation (7090/7290 vs 2920 + 7519/2940).
  let adjustmentEntryId: string | null = null
  if (options.bookAdjustment && report.sek.adjustment_needed) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('company_id', companyId)
      .lte('period_start', report.adjustment_date)
      .gte('period_end', report.adjustment_date)
      .maybeSingle()
    if (!period) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { message: `Ingen räkenskapsperiod täcker ${report.adjustment_date}.` },
      }
    }

    const lines: Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description?: string }> = []
    const d2920 = report.sek.drift_2920
    if (Math.abs(d2920) > DRIFT_TOLERANCE_SEK) {
      // The cost side splits per category, pro rata by each employee's
      // liability (7090 arbetare, 7290 everyone else); 2920 stays one line.
      const parts = splitVacationLiabilityChange(
        report.rows.map((row) => ({ account: row.liability_change_account, liability: row.computed_liability_sek })),
        d2920,
      )
      if (d2920 > 0) {
        for (const part of parts) {
          lines.push({ account_number: part.account, debit_amount: part.amount, credit_amount: 0, line_description: 'Justering semesterlöneskuld' })
        }
        lines.push({ account_number: '2920', debit_amount: 0, credit_amount: d2920, line_description: 'Justering semesterlöneskuld' })
      } else {
        lines.push({ account_number: '2920', debit_amount: -d2920, credit_amount: 0, line_description: 'Justering semesterlöneskuld' })
        for (const part of parts) {
          lines.push({ account_number: part.account, debit_amount: 0, credit_amount: -part.amount, line_description: 'Justering semesterlöneskuld' })
        }
      }
    }
    const d2940 = report.sek.drift_2940
    if (Math.abs(d2940) > DRIFT_TOLERANCE_SEK) {
      if (d2940 > 0) {
        lines.push({ account_number: '7519', debit_amount: d2940, credit_amount: 0, line_description: 'Justering upplupna avgifter semester' })
        lines.push({ account_number: '2940', debit_amount: 0, credit_amount: d2940, line_description: 'Justering upplupna avgifter semester' })
      } else {
        lines.push({ account_number: '2940', debit_amount: -d2940, credit_amount: 0, line_description: 'Justering upplupna avgifter semester' })
        lines.push({ account_number: '7519', debit_amount: 0, credit_amount: -d2940, line_description: 'Justering upplupna avgifter semester' })
      }
    }

    if (lines.length > 0) {
      try {
        // Posting port (step 2): the engine gets the input unchanged; while
        // POSTING_EVENTS is shadow or strict the adjustment's event is
        // recorded first and linked to the draft before a voucher number is
        // drawn.
        const { postingPort } = await import('@/lib/posting/port')
        const { linkBasisColumns } = await import('@/lib/links/stamp')
        const entry = await postingPort.postJournalEntry({
          supabase,
          companyId,
          userId,
          // Built only while the port is on: off, the call is the one it was.
          event: () => vacationYearCloseBusinessEvent(report, linkBasisColumns('user_created')),
          input: {
            fiscal_period_id: (period as { id: string }).id,
            entry_date: report.adjustment_date,
            description: `Semesterårsavslut ${closingYearStart.slice(0, 4)}: justering semesterlöneskuld`,
            source_type: 'salary_payment',
            source_id: closureId,
            lines,
          },
        })
        adjustmentEntryId = entry.id
        const { error: linkError } = await supabase
          .from('vacation_year_closures')
          .update({ adjustment_entry_id: entry.id })
          .eq('id', closureId)
        if (linkError) {
          // The verifikat IS posted; only the closure link failed. Surface
          // it with the entry id so nobody re-posts the adjustment manually.
          return {
            ok: false,
            code: 'VACATION_CLOSE_ADJUSTMENT_FAILED',
            details: {
              closure_id: closureId,
              adjustment_entry_id: entry.id,
              message: `Justeringsverifikatet är bokfört men kunde inte länkas till semesterårsavslutet: ${linkError.message}`,
            },
          }
        }
      } catch (err) {
        // The days roll committed; the adjustment did not. Surface loudly:
        // the closure row (sans adjustment_entry_id) shows exactly what is
        // missing, and the entry can be posted manually from the report.
        return {
          ok: false,
          code: 'VACATION_CLOSE_ADJUSTMENT_FAILED',
          details: {
            closure_id: closureId,
            message: err instanceof Error ? err.message : 'unknown',
          },
        }
      }
    }
  }

  return { ok: true, data: { closure_id: closureId, adjustment_entry_id: adjustmentEntryId, report } }
}
