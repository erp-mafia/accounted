import type { SalaryRun } from '@/types'

/** Latest-attempt payslip delivery counts, from GET /api/salary/runs/[id]. */
export interface PayslipDeliveriesSummary {
  sent: number
  failed: number
  skipped: number
  last_sent_at: string | null
}

/** Effective per-employee totals of the latest booked run before this period. */
export interface PreviousRunDiff {
  id: string
  period_year: number
  period_month: number
  by_employee: Record<string, { gross: number; tax: number; net: number }>
}

/** The run payload as the detail GET returns it (additive fields). */
export type RunDetail = SalaryRun & {
  arbetsgivare?: string | null
  previous_run?: PreviousRunDiff | null
  corrected_by_run_id?: string | null
  payslip_deliveries_summary?: PayslipDeliveriesSummary
}

export function periodLabelOf(run: Pick<SalaryRun, 'period_year' | 'period_month'>): string {
  return `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
}
