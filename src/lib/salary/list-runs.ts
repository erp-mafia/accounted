/**
 * One page of a company's salary runs, oldest first.
 *
 * One implementation behind the v1 route GET /salary-runs and the MCP tool
 * gnubok_list_salary_runs (lib/operations/salary-run-structure.ts), so the
 * filters, the order and the pagination cannot drift between the doors.
 * Each door shapes the rows itself: v1 answers them as they are (with `id`),
 * the MCP tool renames `id` to `salary_run_id`.
 *
 * Keyset pagination on (created_at, id) ascending, the v1 default cursor. A
 * cursor that no longer decodes starts from the first page.
 */
import { z } from 'zod'
import { DEFAULT_LIMIT, decodeDefaultCursor, encodeDefaultCursor } from '@/lib/api/v1/pagination'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

export const SalaryRunStatusSchema = z.enum(['draft', 'review', 'approved', 'paid', 'booked', 'corrected'])
export type SalaryRunStatus = z.infer<typeof SalaryRunStatusSchema>

/**
 * The filters both doors validate. Coerced because v1 reads them from the
 * query string.
 */
export const SalaryRunListFiltersSchema = z.object({
  period_year: z.coerce
    .number()
    .int()
    .min(2020)
    .max(2100)
    .optional()
    .describe('Only runs for this payroll year (2020-2100).'),
  status: SalaryRunStatusSchema.optional().describe('Only runs in this status.'),
})

export const SALARY_RUN_SUMMARY_COLUMNS =
  'id, period_year, period_month, payment_date, deviation_period_start, deviation_period_end, status, voucher_series, total_gross, total_tax, total_net, total_avgifter, total_employer_cost, agi_generated_at, agi_submitted_at, approved_at, paid_at, booked_at, created_at'

/** A salary_runs row as SALARY_RUN_SUMMARY_COLUMNS selects it. */
export interface SalaryRunSummaryRow {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  deviation_period_start: string | null
  deviation_period_end: string | null
  status: SalaryRunStatus
  voucher_series: string
  total_gross: number
  total_tax: number
  total_net: number
  total_avgifter: number
  total_employer_cost: number
  agi_generated_at: string | null
  agi_submitted_at: string | null
  approved_at: string | null
  paid_at: string | null
  booked_at: string | null
  created_at: string
}

export interface ListSalaryRunsArgs {
  periodYear?: number
  periodMonth?: number
  status?: SalaryRunStatus
  cursor?: string | null
  /** Page size; the doors bound it to 1-100. Defaults to 50. */
  limit?: number
}

export interface SalaryRunsPage {
  runs: SalaryRunSummaryRow[]
  /** Pass back as the cursor for the next page; null on the last page. */
  next_cursor: string | null
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export async function listSalaryRuns(
  ctx: Pick<OperationContext, 'supabase' | 'companyId'>,
  args: ListSalaryRunsArgs,
): Promise<{ ok: true; data: SalaryRunsPage } | Failure> {
  const limit = args.limit ?? DEFAULT_LIMIT
  const decoded = decodeDefaultCursor(args.cursor)

  let query = ctx.supabase
    .from('salary_runs')
    .select(SALARY_RUN_SUMMARY_COLUMNS)
    .eq('company_id', ctx.companyId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 1)

  if (args.periodYear !== undefined) query = query.eq('period_year', args.periodYear)
  if (args.periodMonth !== undefined) query = query.eq('period_month', args.periodMonth)
  if (args.status) query = query.eq('status', args.status)
  if (decoded) {
    query = query.or(`created_at.gt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`)
  }

  const { data, error } = await query
  if (error) return { ok: false, code: 'UNKNOWN_ERROR', error }

  const rows = (data ?? []) as unknown as SalaryRunSummaryRow[]
  const runs = rows.slice(0, limit)
  const last = runs[runs.length - 1]
  return {
    ok: true,
    data: { runs, next_cursor: rows.length > limit && last ? encodeDefaultCursor(last) : null },
  }
}
