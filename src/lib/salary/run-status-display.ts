import type { SalaryRunStatus } from '@/types'
import type { StatusDisplay } from '@/lib/status-display'

/**
 * A salary run's status as every surface shows it: the Löner list, the run
 * header and the employee's payslip page. Labels live in the `salary`
 * namespace.
 *
 * In-flight states wear the quiet beige chip (the payout-date note beside it
 * carries the urgency), corrected is the outline exception, and paid and
 * booked are the normal outcome: muted text.
 */
const SALARY_RUN_STATUS_DISPLAY: Record<SalaryRunStatus, StatusDisplay> = {
  draft: { labelKey: 'status_draft', chip: 'secondary' },
  review: { labelKey: 'status_review', chip: 'secondary' },
  approved: { labelKey: 'status_approved', chip: 'secondary' },
  paid: { labelKey: 'status_paid', chip: null },
  booked: { labelKey: 'status_booked', chip: null },
  corrected: { labelKey: 'status_corrected', chip: 'outline' },
}

/** Null for a status this build does not know, so the caller can show the raw value. */
export function salaryRunStatusDisplay(status: string): StatusDisplay | null {
  return SALARY_RUN_STATUS_DISPLAY[status as SalaryRunStatus] ?? null
}

export const SALARY_RUN_STATUSES = Object.keys(SALARY_RUN_STATUS_DISPLAY) as SalaryRunStatus[]
