import { z } from 'zod'

/**
 * Company-level payroll calculation conventions (beräkningsprinciper).
 *
 * Swedish law fixes WHAT is paid (SjLL 6 § sjuklön at 80 %, one karensavdrag
 * per sjuklöneperiod; SemL 16-17 §§ semesterlön; SFL 11 kap. skatteavdrag)
 * but leaves HOW a monthly salary is converted into a day, an hour or a
 * partial month to the employment contract and the kollektivavtal. Every
 * payroll system picks conventions there, and a customer moving from Fortnox
 * (the reference for these options) expects the same öre on the payslip.
 * Each convention below is an explicit opt-in. The default of every key
 * reproduces the engine's historical numbers exactly, so an existing company
 * calculates the same before and after this schema existed.
 *
 * Stored on company_settings.salary_calculation_policy (jsonb, migration
 * 20260919120100) and snapshotted into salary_runs.calculation_params at
 * :calculate, so a run keeps the conventions it was calculated with even if
 * the company changes them later.
 *
 * Adding a convention: add it to SALARY_CALCULATION_POLICY_OPTIONS with a
 * default (first option) that keeps today's behaviour, extend the
 * company_settings CHECK in a NEW migration, the sv/en strings under
 * settings_salary (label, help, one per option) and the cookbook section.
 */

/**
 * Allowed values per convention. The FIRST value is the default and the
 * historical engine behaviour.
 *
 * partial_month: base salary for an employment that starts or ends inside
 *   the pay month.
 *   - workdays: månadslön × arbetsdagar i anställning / arbetsdagar i
 *     perioden (Mon-Fri, no holiday exclusion, the same convention as the
 *     21-day daily rate).
 *   - annual_calendar_days: Fortnox's default. Every calendar day employed
 *     is worth (månadslön × 12 / 365) rounded to öre, times the calendar
 *     days employed inside the period; 365 also in a leap year; a full month
 *     always pays the full salary. No statute governs this; most
 *     tjänstemannaavtal use the calendar-day form.
 *
 * sick_rate: how lost pay and sjuklön are priced for sick days 1-14
 *   (SjLL 6 §).
 *   - daily_divisor: månadslön / dagdivisor (21 at a five-day week, the
 *     schedule formula otherwise), weighted by the row's hours against the
 *     scheduled hours per day.
 *   - annual_hourly: Fortnox's formula. Timlön = månadslön × 12 / (52 ×
 *     veckoarbetstid); sjukavdrag per timme = timlön; sjuklön per timme =
 *     80 % × timlön, applied to the absent hours. The karensavdrag (20 % of
 *     an average week's sjuklön) is schedule-independent and identical under
 *     both. The statute prescribes the 80 % and the weekly karens; the
 *     per-hour or per-day measure of "lost pay" is the agreement's.
 *
 * long_leave: deduction for leave without pay longer than a working week:
 *   föräldraledighet, tjänstledighet utan lön and sjukfrånvaro from day 15
 *   (Försäkringskassan period).
 *   - workdays: every absent day deducts one daily rate (månadslön /
 *     dagdivisor), weighted by hours.
 *   - calendar_after_five_workdays: the tjänstemannaavtal rule Fortnox
 *     implements. An episode of at most five working days deducts per
 *     working day (månadslön / dagdivisor). A longer episode deducts per
 *     CALENDAR day, weekends included, at månadslön × 12 / 365. An episode
 *     covering the whole calendar month deducts exactly the monthly salary.
 *     Sick day 15+ is always priced at the calendar rate. Five-day schedules
 *     only (workdays_per_week = 5); the calculation refuses others. SemL and
 *     SjLL are silent on the measure; this is kollektivavtal.
 *
 * leave_context: which registered absence decides whether an episode is
 *   longer than five working days under long_leave =
 *   calendar_after_five_workdays. No effect under long_leave = workdays.
 *   - all_registered: every registered day, including days after the
 *     deviation period's end (leave already booked for next month), so the
 *     first month of a long leave is priced at the calendar rate from the
 *     start.
 *   - through_deviation_end: only days up to and including the deviation
 *     period's end. Days registered later never reclassify a month that was
 *     already settled as a short episode. Fortnox behaves this way when the
 *     leave is registered month by month.
 *
 * net_rounding: direction of the whole-krona öresavrundning of the net
 *   payout, when company_settings.salary_net_rounding is on. Nothing in law
 *   requires whole-krona payouts; banks do.
 *   - up: always up, never underpaying a wage; the 0-99 öre books as a 3740
 *     debit.
 *   - nearest: Fortnox's "avrunda till närmaste hela krona". The difference
 *     can be negative (up to 49 öre less) and books as a 3740 credit.
 *
 * one_off_tax_rounding: rounding of engångsskatt (per-line
 *   one_off_tax_percent, lib/salary/one-off-tax.ts).
 *   - truncate: belopp × procent, öretal bortfaller (SFL 22 kap. 1 §:
 *     skatteavdrag anges i hela kronor). Statutory.
 *   - nearest: compatibility with systems that round the one-off tax to the
 *     nearest krona; off by at most one krona per rate group. Kept so a
 *     migrated customer's historical payslips can be reproduced.
 */
export const SALARY_CALCULATION_POLICY_OPTIONS = {
  partial_month: ['workdays', 'annual_calendar_days'],
  sick_rate: ['daily_divisor', 'annual_hourly'],
  long_leave: ['workdays', 'calendar_after_five_workdays'],
  leave_context: ['all_registered', 'through_deviation_end'],
  net_rounding: ['up', 'nearest'],
  one_off_tax_rounding: ['truncate', 'nearest'],
} as const

export type SalaryCalculationPolicyKey = keyof typeof SALARY_CALCULATION_POLICY_OPTIONS

export const SALARY_CALCULATION_POLICY_KEYS = Object.keys(
  SALARY_CALCULATION_POLICY_OPTIONS,
) as SalaryCalculationPolicyKey[]

/** Bare enums, shared by the full schema (with defaults) and the PATCH schema (without). */
const conventions = {
  partial_month: z.enum(SALARY_CALCULATION_POLICY_OPTIONS.partial_month),
  sick_rate: z.enum(SALARY_CALCULATION_POLICY_OPTIONS.sick_rate),
  long_leave: z.enum(SALARY_CALCULATION_POLICY_OPTIONS.long_leave),
  leave_context: z.enum(SALARY_CALCULATION_POLICY_OPTIONS.leave_context),
  net_rounding: z.enum(SALARY_CALCULATION_POLICY_OPTIONS.net_rounding),
  one_off_tax_rounding: z.enum(SALARY_CALCULATION_POLICY_OPTIONS.one_off_tax_rounding),
}

/** Full policy: every key present; the defaults reproduce the historical engine. */
export const SalaryCalculationPolicySchema = z
  .object({
    partial_month: conventions.partial_month.default(SALARY_CALCULATION_POLICY_OPTIONS.partial_month[0]),
    sick_rate: conventions.sick_rate.default(SALARY_CALCULATION_POLICY_OPTIONS.sick_rate[0]),
    long_leave: conventions.long_leave.default(SALARY_CALCULATION_POLICY_OPTIONS.long_leave[0]),
    leave_context: conventions.leave_context.default(SALARY_CALCULATION_POLICY_OPTIONS.leave_context[0]),
    net_rounding: conventions.net_rounding.default(SALARY_CALCULATION_POLICY_OPTIONS.net_rounding[0]),
    one_off_tax_rounding: conventions.one_off_tax_rounding.default(
      SALARY_CALCULATION_POLICY_OPTIONS.one_off_tax_rounding[0],
    ),
  })
  .strict()

/**
 * PATCH shape: any subset of the conventions, no defaults, so a caller that
 * sends one key cannot silently reset the others. The v1 settings route
 * merges this into the stored policy and re-parses with the full schema.
 */
export const SalaryCalculationPolicyPatchSchema = z.object(conventions).partial().strict()

export type SalaryCalculationPolicy = z.infer<typeof SalaryCalculationPolicySchema>
export type SalaryCalculationPolicyPatch = z.infer<typeof SalaryCalculationPolicyPatchSchema>

/** The historical engine behaviour, spelled out. */
export const DEFAULT_SALARY_CALCULATION_POLICY: SalaryCalculationPolicy = SalaryCalculationPolicySchema.parse({})
