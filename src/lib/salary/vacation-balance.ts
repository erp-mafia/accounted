/**
 * One employee's open vacation balance, as the v1 GET
 * /employees/{id}/vacation-balance and the MCP tool gnubok_get_vacation_balance
 * answer it. Both used to read and compute it themselves; the MCP copy had
 * already lost saved_days_total.
 *
 * The employee is read first, so a wrong id is EMPLOYEE_NOT_FOUND, never "no
 * balance yet". A missing ledger row is VACATION_BALANCE_NOT_FOUND, not zeros:
 * the row is seeded by the first booked run (or the vacation year close), and
 * zeros would claim no entitlement.
 *
 * The SEK estimate is the BFNAR 2016:10 day valuation the year close also
 * uses (dayValueSek at the company's vacation_day_value convention; under
 * procentregeln the earning year's day value where Accounted holds that
 * year), on remaining paid days plus sparade dagar
 * still held, floored at zero: an overdrawn balance is a receivable, not a
 * negative skuld.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { dayValueSek, type DayValueEmployee } from '@/lib/salary/semesterberedning'
import { vacationDayValuePolicyFrom } from '@/lib/salary/calculation-policy'
import { loadProcentregelnLiabilityValues } from '@/lib/salary/procentregeln-liability'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { remainingSavedDays, sumDays } from '@/lib/salary/vacation-category'
import { paidDaysAsDaysOff, paidDaysPerDayOff } from '@/lib/salary/vacation-net-days'

export interface VacationBalance {
  employee_vacation_balance_id: string
  employee_id: string
  vacation_year_start: string
  entitled_days: number
  accrued_days: number
  taken_days: number
  remaining_days: number
  /**
   * The days the employee can still take off: remaining_days at five workdays
   * a week or more, fewer below (25 paid days are 20 days off at four days a
   * week, Semesterlagen 12 a §; vacation-net-days.ts).
   */
  remaining_days_off: number
  /** Origin year -> days still held (the seed minus saved_days_taken). */
  saved_days: Record<string, number>
  saved_days_total: number
  /** Origin year -> days consumed this year by saved vacation lines. */
  saved_days_taken: Record<string, number>
  unpaid_days: number
  advance_days: number
  forced_payout_days: number
  estimated_liability_sek: number
}

export type VacationBalanceResult =
  | { ok: true; data: VacationBalance }
  | { ok: false; code: 'EMPLOYEE_NOT_FOUND' | 'VACATION_BALANCE_NOT_FOUND' }
  | { ok: false; code: 'INTERNAL_ERROR'; cause: unknown }

export async function readVacationBalance(
  supabase: SupabaseClient,
  args: { companyId: string; employeeId: string },
): Promise<VacationBalanceResult> {
  const { data: employee, error: empErr } = await supabase
    .from('employees')
    .select('id, vacation_rule, vacation_days_per_year, vacation_pay_rate, semestertillagg_rate, salary_type, monthly_salary, employment_degree, hourly_rate, hours_per_week, workdays_per_week, employment_start, employment_end')
    .eq('id', args.employeeId)
    .eq('company_id', args.companyId)
    .maybeSingle()
  // A malformed id (22P02) is a wrong id.
  if (empErr && (empErr as { code?: string }).code !== '22P02') {
    return { ok: false, code: 'INTERNAL_ERROR', cause: empErr }
  }
  if (!employee) return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }

  const { data: balance, error: balErr } = await supabase
    .from('employee_vacation_balances')
    .select('id, employee_id, vacation_year_start, entitled_days, accrued_days, taken_days, saved_days, forced_payout_days, unpaid_days, advance_days, saved_days_taken')
    .eq('company_id', args.companyId)
    .eq('employee_id', args.employeeId)
    .eq('status', 'open')
    .order('vacation_year_start', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (balErr) return { ok: false, code: 'INTERNAL_ERROR', cause: balErr }
  if (!balance) return { ok: false, code: 'VACATION_BALANCE_NOT_FOUND' }

  const row = balance as {
    id: string
    employee_id: string
    vacation_year_start: string
    entitled_days: number | null
    accrued_days: number | null
    taken_days: number | null
    saved_days: Record<string, number> | null
    forced_payout_days: number | null
    unpaid_days?: number | null
    advance_days?: number | null
    saved_days_taken?: Record<string, number> | null
  }
  const savedTaken = row.saved_days_taken ?? {}
  const savedDays = remainingSavedDays(row.saved_days ?? {}, savedTaken)
  const savedTotal = sumDays(savedDays)
  const entitled = row.entitled_days ?? 0
  const taken = row.taken_days ?? 0
  const remaining = roundOre(entitled - taken)
  const schedule = employee as unknown as DayValueEmployee
  // The company's day-value convention (calculation-policy.ts
  // vacation_day_value), the one the report and the year close price with.
  const { data: policyRow } = await supabase
    .from('company_settings')
    .select('salary_calculation_policy, salary_vacation_year_basis')
    .eq('company_id', args.companyId)
    .maybeSingle()
  const settings = policyRow as { salary_calculation_policy?: unknown; salary_vacation_year_basis?: string } | null
  let dayValue = dayValueSek(schedule, vacationDayValuePolicyFrom(settings?.salary_calculation_policy))
  // Procentregeln: a day is worth what the payout pays for it, the earning
  // year's semesterlön per day (16 b §), not today's salary; the estimate
  // stands in where Accounted lacks that year.
  const emp = employee as { vacation_rule?: string; employment_start?: string | null; employment_end?: string | null }
  if (emp.vacation_rule === 'procentregeln' && emp.employment_start) {
    try {
      const values = await loadProcentregelnLiabilityValues(supabase, {
        companyId: args.companyId,
        basis: settings?.salary_vacation_year_basis === 'statutory_apr_mar' ? 'statutory_apr_mar' : 'calendar',
        asOfDate: todayIsoStockholm(),
        employees: [
          {
            id: args.employeeId,
            vacation_days_per_year: schedule.vacation_days_per_year,
            vacation_pay_rate: schedule.vacation_pay_rate,
            employment_start: emp.employment_start,
            employment_end: emp.employment_end ?? null,
          },
        ],
      })
      dayValue = values.get(args.employeeId)?.perDay ?? dayValue
    } catch (err) {
      return { ok: false, code: 'INTERNAL_ERROR', cause: err }
    }
  }

  return {
    ok: true,
    data: {
      employee_vacation_balance_id: row.id,
      employee_id: row.employee_id,
      vacation_year_start: row.vacation_year_start,
      entitled_days: entitled,
      accrued_days: row.accrued_days ?? 0,
      taken_days: taken,
      remaining_days: remaining,
      remaining_days_off: paidDaysAsDaysOff(
        remaining,
        paidDaysPerDayOff(schedule.vacation_days_per_year, schedule.workdays_per_week),
      ),
      saved_days: savedDays,
      saved_days_total: savedTotal,
      saved_days_taken: savedTaken,
      unpaid_days: row.unpaid_days ?? 0,
      advance_days: row.advance_days ?? 0,
      forced_payout_days: row.forced_payout_days ?? 0,
      estimated_liability_sek: roundOre(Math.max(0, remaining + savedTotal) * dayValue),
    },
  }
}
