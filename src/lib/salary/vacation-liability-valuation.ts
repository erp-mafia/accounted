/**
 * The day-valued semesterlöneskuld as of a date, per employee (K2 punkt
 * 17.10: calculated individually, lagstadgade arbetsgivaravgifter included).
 * Read-only: it books nothing.
 *
 * One valuation for every reader that needs the liability as it stands: the
 * Semesterskuld report's computed column, the remeasurement a salary run
 * books under the 'remeasure' method, and the standalone "stäm av per
 * datum" (vacation-liability-remeasure.ts). The semesterårsavslut values the
 * same days through the same pure pieces (vacationLiabilityDays, dayValueSek,
 * liabilityAvgifterRate), so a remeasured company's close finds next to no
 * drift.
 *
 * Days per employee (vacation-liability-days.ts): the vacation year
 * containing the date, derived the way the vacation ledger derives it
 * (deriveVacationLedgerRow) but from the runs that count by the date, plus
 * the paid days left in earlier years not closed yet. A run counts when it
 * is booked (or is the run being booked, `inFlightRunId`) and either was paid
 * on or before the date or deducts leave that ended on or before it. The
 * stored ledger counts every booked run whatever the date, so a valuation of
 * a past date would otherwise subtract leave taken after it.
 *
 * SEK under sammalöneregeln: days x dayValueSek at the company's
 * vacation_day_value convention, plus the semesterlön of the rörliga
 * lönedelar still unpaid (Semesterlagen 16 a § tredje stycket: earned in the
 * previous and the running semesterår, less what was paid out since the
 * running year began). Under procentregeln: the days owed at the earning
 * year's day value and, on the statutory basis, the running intjänandeår's
 * semesterlön so far; on the calendar basis an employee the payout has no
 * day value for (not employed the whole previous year, or its payslips are
 * not in Accounted) has the running year's days valued from its semesterlön
 * so far (procentregeln-liability.ts,
 * 16 b §); dayValueSek's estimate from today's pay only where Accounted lacks
 * the pay.
 * Avgifter: each employee's age-tier rate of the year after the date.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { roundOre, sumOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dayValueSek, type DayValueEmployee } from './semesterberedning'
import { vacationDayValuePolicyFrom, type VacationDayValuePolicy } from './calculation-policy'
import { liabilityAvgifterRate, liabilitySettlementYear, vacationLiabilityDays, type VacationLiabilityDays } from './vacation-liability-days'
import { deriveVacationLedgerRow, type BookedRunRow, type LedgerOpeningRow } from './vacation-ledger'
import { remainingSavedDays, sumDays } from './vacation-category'
import { runDeviationWindow } from './deviation-period'
import { getVacationYearStart, type VacationYearBasis } from './vacation-year'
import { loadVariablePayRuns, previousVacationYearStart, variableVacationPayOwed } from './variable-vacation-pay'
import { resolveVacationPayRate } from './vacation-pay-rate'
import { loadProcentregelnLiabilityValues, procentregelnLiabilitySek } from './procentregeln-liability'
import { vacationLiabilityChangeAccount, type VacationLiabilityChangeAccount } from './account-mapping'

export interface VacationLiabilityEmployeeValue {
  employee_id: string
  employee_name: string
  vacation_rule: string
  /** 7090 arbetare, 7290 everyone else: where a change of the liability books. */
  liability_change_account: VacationLiabilityChangeAccount
  /** The employee's dimensions bag, for the cost side of a remeasurement. */
  default_dimensions: Record<string, string> | null
  days: VacationLiabilityDays
  day_value_sek: number
  /** Days priced at day_value_sek: every owed day, except under procentregeln the days of the running intjänandeår that earning_sek values instead (procentregelnLiabilitySek). */
  valued_days: number
  /** Procentregeln: the running intjänandeår's semesterlön so far (16 b §) for the days valued_days leaves out. 0 otherwise. */
  earning_sek: number
  /** Procentregeln: whether the value rests on the earning year's pay (16 b §) or, lacking it, on today's pay. Sammalöneregeln: always 'current_pay'. */
  day_value_basis: 'earning_year' | 'current_pay'
  variable_vacation_pay_sek: number
  computed_liability_sek: number
  avgifter_rate: number
  computed_avgifter_sek: number
}

export interface VacationLiabilityValuation {
  as_of_date: string
  basis: VacationYearBasis
  /** First day of the vacation year containing the date. */
  vacation_year_start: string
  day_value_policy: VacationDayValuePolicy
  /** The year whose avgifter rates the liability carries (liabilitySettlementYear). */
  settlement_year: number
  rows: VacationLiabilityEmployeeValue[]
  totals: { computed_liability: number; computed_avgifter: number }
}

interface RosterRow extends DayValueEmployee {
  id: string
  first_name: string
  last_name: string
  employment_type: string
  personnel_category: string | null
  personnummer: string | null
  default_dimensions: Record<string, string> | null
  vacation_days_saved: number | null
  employment_start: string
  employment_end: string | null
}

interface LedgerRow {
  employee_id: string
  vacation_year_start: string
  status: 'open' | 'closed'
  saved_days: Record<string, number> | null
  forced_payout_days: number | null
}

type CountedRunRow = BookedRunRow & {
  salary_run: (BookedRunRow['salary_run'] & { id: string; payment_date: string }) | null
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Booked, or the run being booked, and paid or with its leave over by the date. */
function countsByDate(row: CountedRunRow, asOfDate: string, inFlightRunId: string | undefined): boolean {
  const run = row.salary_run
  if (!run) return false
  if (run.status !== 'booked' && run.id !== inFlightRunId) return false
  return run.payment_date <= asOfDate || runDeviationWindow(run).end <= asOfDate
}

export async function computeVacationLiability(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
  options: { inFlightRunId?: string } = {},
): Promise<VacationLiabilityValuation> {
  if (!ISO_DATE_RE.test(asOfDate) || Number.isNaN(Date.parse(`${asOfDate}T00:00:00Z`))) {
    throw new Error(`Invalid as-of date: ${asOfDate}`)
  }

  const { data: settingsRow, error: settingsError } = await supabase
    .from('company_settings')
    .select('salary_vacation_year_basis, salary_calculation_policy')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) throw settingsError
  const settings = settingsRow as { salary_vacation_year_basis?: string; salary_calculation_policy?: unknown } | null
  const basis: VacationYearBasis = settings?.salary_vacation_year_basis === 'statutory_apr_mar' ? 'statutory_apr_mar' : 'calendar'
  const dayValuePolicy = vacationDayValuePolicyFrom(settings?.salary_calculation_policy)
  const yearStart = getVacationYearStart(asOfDate, basis)
  const settlementYear = liabilitySettlementYear(asOfDate)

  const roster = await fetchAllRows<RosterRow>(({ from, to }) =>
    supabase
      .from('employees')
      .select(
        'id, first_name, last_name, employment_type, personnel_category, personnummer, default_dimensions, vacation_rule, vacation_days_per_year, vacation_days_saved, vacation_pay_rate, semestertillagg_rate, salary_type, monthly_salary, employment_degree, hourly_rate, hours_per_week, workdays_per_week, employment_start, employment_end',
      )
      .eq('company_id', companyId)
      .eq('is_active', true)
      .not('vacation_rule', 'in', '(none,semesterersattning)')
      .order('last_name')
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: RosterRow[] | null; error: { message: string } | null }>,
  )

  const empty: VacationLiabilityValuation = {
    as_of_date: asOfDate,
    basis,
    vacation_year_start: yearStart,
    day_value_policy: dayValuePolicy,
    settlement_year: settlementYear,
    rows: [],
    totals: { computed_liability: 0, computed_avgifter: 0 },
  }
  if (roster.length === 0) return empty

  const ledgerRows = await fetchAllRows<LedgerRow & { id: string }>(({ from, to }) =>
    supabase
      .from('employee_vacation_balances')
      .select('id, employee_id, vacation_year_start, status, saved_days, forced_payout_days')
      .eq('company_id', companyId)
      .lte('vacation_year_start', yearStart)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<LedgerRow & { id: string }> | null; error: { message: string } | null }>,
  )

  const { data: openingData, error: openingError } = await supabase
    .from('employee_opening_balances')
    // One literal string, so the schema guard can check every column.
    .select(
      'employee_id, cutover_date, vacation_paid_days_remaining, vacation_days_taken_this_year, vacation_saved_days_by_year, vacation_as_of_date, vacation_unpaid_days_remaining, vacation_advance_days_remaining, vacation_extra_paid_days_remaining',
    )
    .eq('company_id', companyId)
  if (openingError) throw openingError
  const openingByEmployee = new Map(
    ((openingData ?? []) as unknown as LedgerOpeningRow[]).map((o) => [o.employee_id, o]),
  )

  const bookedRuns = await fetchAllRows<CountedRunRow>(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select(
        'employee_id, vacation_days_taken, vacation_paid_days_per_day_off, line_items:salary_line_items(item_type, quantity, vacation_category, vacation_saved_year), salary_run:salary_runs!inner(id, payment_date, period_year, period_month, status, deviation_period_start, deviation_period_end)',
      )
      .eq('company_id', companyId)
      .eq('salary_run.status', 'booked')
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: CountedRunRow[] | null; error: { message: string } | null }>,
  )
  let inFlightRuns: CountedRunRow[] = []
  if (options.inFlightRunId) {
    const { data, error } = await supabase
      .from('salary_run_employees')
      .select(
        'employee_id, vacation_days_taken, vacation_paid_days_per_day_off, line_items:salary_line_items(item_type, quantity, vacation_category, vacation_saved_year), salary_run:salary_runs!inner(id, payment_date, period_year, period_month, status, deviation_period_start, deviation_period_end)',
      )
      .eq('company_id', companyId)
      .eq('salary_run_id', options.inFlightRunId)
    if (error) throw error
    inFlightRuns = (data ?? []) as unknown as CountedRunRow[]
  }
  const counted = [...bookedRuns, ...inFlightRuns].filter((row) => countsByDate(row, asOfDate, options.inFlightRunId))

  // Rörliga lönedelar (sammalöneregeln only): payslips paid from the previous
  // vacation year's start up to and including the date.
  const sammaloneIds = roster.filter((e) => e.vacation_rule === 'sammaloneregeln').map((e) => e.id)
  const previousStart = previousVacationYearStart(yearStart)
  const dayAfter = addDays(asOfDate, 1)
  const variableRuns = await loadVariablePayRuns(supabase, {
    companyId,
    employeeIds: sammaloneIds,
    from: previousStart,
    to: dayAfter,
  })

  // Procentregeln: the earning year's day value and the running year's
  // semesterlön so far, from the payslips.
  const procentValues = await loadProcentregelnLiabilityValues(supabase, {
    companyId,
    basis,
    asOfDate,
    employees: roster.filter((e) => e.vacation_rule === 'procentregeln'),
    inFlightRunId: options.inFlightRunId,
  })

  const rows: VacationLiabilityEmployeeValue[] = []
  for (const emp of roster) {
    const opening = openingByEmployee.get(emp.id) ?? null
    const runs = counted.filter((r) => r.employee_id === emp.id)
    const employee = {
      vacation_days_per_year: emp.vacation_days_per_year,
      vacation_days_saved: emp.vacation_days_saved ?? 0,
      employment_start: emp.employment_start,
    }
    const ownRows = ledgerRows.filter((r) => r.employee_id === emp.id)
    const currentRow = ownRows.find((r) => r.vacation_year_start === yearStart) ?? null
    const current = deriveVacationLedgerRow({
      basis,
      yearStart,
      asOfDate,
      employee,
      opening,
      seedRow: currentRow,
      bookedRuns: runs,
    })
    // Earlier years still open: their paid days are owed until the close
    // saves them or lets them lapse. Their sparade dagar are not added: the
    // running year's row carries the saved seed.
    let unclosedYearDays = 0
    for (const prior of ownRows) {
      if (prior.status !== 'open' || prior.vacation_year_start >= yearStart) continue
      const derived = deriveVacationLedgerRow({
        basis,
        yearStart: prior.vacation_year_start,
        asOfDate,
        employee,
        opening,
        seedRow: prior,
        bookedRuns: runs,
      })
      unclosedYearDays += Math.max(0, derived.entitled_days - derived.taken_days)
    }

    const days = vacationLiabilityDays({
      basis,
      yearStart,
      asOfDate,
      entitledDays: current.entitled_days,
      takenDays: current.taken_days,
      savedDays: sumDays(remainingSavedDays(current.saved_days, current.saved_days_taken)),
      vacationDaysPerYear: emp.vacation_days_per_year,
      employmentStart: emp.employment_start,
      employmentEnd: emp.employment_end,
      unclosedYearDays,
    })

    const variableVacationPay =
      emp.vacation_rule === 'sammaloneregeln'
        ? variableVacationPayOwed({
            runs: (variableRuns.get(emp.id) ?? []).filter(
              (run) => run.status === 'booked' || run.salaryRunId === options.inFlightRunId,
            ),
            rate: resolveVacationPayRate(emp.vacation_days_per_year, emp.vacation_pay_rate),
            window: { earnedFrom: previousStart, earnedTo: dayAfter, paidFrom: yearStart, paidTo: dayAfter },
          }).unpaid
        : 0

    const estimate = dayValueSek(emp, dayValuePolicy)
    const procent =
      emp.vacation_rule === 'procentregeln' ? procentregelnLiabilitySek(days, procentValues.get(emp.id), estimate) : null
    const dayValue = procent ? procent.dayValue : estimate
    const liability = procent ? procent.liability : roundOre(days.total_days * dayValue + variableVacationPay)
    const valuedDays = procent ? procent.valuedDays : days.total_days
    const earningSek = procent ? roundOre(liability - roundOre(valuedDays * dayValue)) : 0
    const rate = liabilityAvgifterRate(emp.personnummer, settlementYear)
    rows.push({
      employee_id: emp.id,
      employee_name: `${emp.first_name} ${emp.last_name}`,
      vacation_rule: emp.vacation_rule,
      liability_change_account: vacationLiabilityChangeAccount({
        employmentType: emp.employment_type,
        personnelCategory: emp.personnel_category,
      }),
      default_dimensions: emp.default_dimensions ?? null,
      days,
      day_value_sek: dayValue,
      valued_days: valuedDays,
      earning_sek: earningSek,
      day_value_basis: procent?.fromEarningYear ? 'earning_year' : 'current_pay',
      variable_vacation_pay_sek: variableVacationPay,
      computed_liability_sek: liability,
      avgifter_rate: rate,
      computed_avgifter_sek: roundOre(liability * rate),
    })
  }

  return {
    ...empty,
    rows,
    totals: {
      computed_liability: sumOre(rows.map((r) => r.computed_liability_sek)),
      computed_avgifter: sumOre(rows.map((r) => r.computed_avgifter_sek)),
    },
  }
}
