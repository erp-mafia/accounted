import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import { effectiveRunTotals, type EffectiveFiguresInput, type EffectiveRunTotals } from './effective-figures'

export type OverrideAffectedTotals = Pick<
  EffectiveRunTotals,
  'total_tax' | 'total_net' | 'total_avgifter' | 'total_employer_cost'
>

/**
 * Re-derive the stored salary_runs totals that a review-step override moves
 * (tax, net, avgifter, employer cost) from the run's per-employee rows.
 *
 * The calculation writes the totals once; an override written afterwards
 * (PATCH .../employees/[employeeId]) used to leave them at the calculated
 * values, so every reader of salary_runs.total_* (the run list, the MCP
 * run read, the booking preview) disagreed with the posted verifikat.
 * Gross and vacation accrual cannot be overridden and are left as written.
 *
 * Only a run in `review` (where overrides are set) is written: an approved
 * or booked run keeps the totals it was approved with. Returns null when no
 * review run matched (the run moved on between the override and this
 * write); a database error throws.
 */
export async function refreshRunTotals(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
): Promise<OverrideAffectedTotals | null> {
  // The employee embed is many-to-one (one object per row); the untyped
  // client infers an array, hence the cast.
  const rows = (await fetchAllRows(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select(
        'id, gross_salary, tax_withheld, tax_withheld_override, net_salary, avgifter_amount, avgifter_amount_override, vacation_accrual, vacation_accrual_avgifter, employee:employees(f_skatt_status)',
      )
      .eq('salary_run_id', salaryRunId)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )) as unknown as EffectiveFiguresInput[]
  const totals = effectiveRunTotals(rows)
  const { data: updated, error } = await supabase
    .from('salary_runs')
    .update({
      total_tax: totals.total_tax,
      total_net: totals.total_net,
      total_avgifter: totals.total_avgifter,
      total_employer_cost: totals.total_employer_cost,
    })
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .eq('status', 'review')
    .select('id')
  if (error) throw dbError(error)
  if (!updated || updated.length === 0) return null
  return {
    total_tax: totals.total_tax,
    total_net: totals.total_net,
    total_avgifter: totals.total_avgifter,
    total_employer_cost: totals.total_employer_cost,
  }
}
