import { z } from 'zod'

/** Employer conventions, not universal statutory formulas. Defaults preserve
 * existing companies; operators must explicitly select a different agreement. */
export const SalaryCalculationPolicySchema = z.object({
  partial_month: z.enum(['workdays', 'annual_calendar_days']).default('workdays'),
  net_rounding: z.enum(['up', 'nearest']).default('up'),
  sick_rate: z.enum(['daily_divisor', 'annual_hourly']).default('daily_divisor'),
  long_leave: z.enum(['workdays', 'calendar_after_five_workdays']).default('workdays'),
  // Historical cutoffs can classify leave using only information through
  // the deviation period. Retain lookback, but do not let future bookings
  // silently turn a previously settled short episode into long leave.
  leave_context: z.enum(['all_registered', 'through_deviation_end']).default('all_registered'),
  one_off_tax_rounding: z.enum(['truncate', 'nearest']).default('truncate'),
}).strict()

export type SalaryCalculationPolicy = z.infer<typeof SalaryCalculationPolicySchema>
