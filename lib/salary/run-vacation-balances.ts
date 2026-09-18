import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { runDeviationWindow } from './deviation-period'
import { rollVacationBalance, VacationBalanceSchema, type VacationBalance, type VacationMovement } from './vacation-balance'

interface VacationRunRow {
  employee_id: string
  line_items?: Array<{ item_type: string; quantity: number | null; calculation_source?: string | null; vacation_movements?: VacationMovement[] }>
}
interface RunWindow {
  period_year: number
  period_month: number
  deviation_period_start?: string | null
  deviation_period_end?: string | null
}

/** Rebuild from openings and authorized runs, never from yesterday's mutable
 * balance. Historical leave covered by the opening is not deducted again. */
export async function computeRunVacationBalances(supabase: SupabaseClient, args: {
  companyId: string; runId: string; run: RunWindow; current: VacationRunRow[]
  openings: Array<{ employee_id: string; vacation_balance?: VacationBalance | null }>
}): Promise<Map<string, VacationBalance>> {
  const openings = args.openings.filter(row => row.vacation_balance != null)
  const result = new Map<string, VacationBalance>()
  if (!openings.length) return result
  const previous = await fetchAllRows(({ from, to }) => supabase.from('salary_run_employees')
    .select('employee_id, line_items:salary_line_items(item_type, quantity, calculation_source, vacation_movements), salary_run:salary_runs!inner(id, period_year, period_month, status, deviation_period_start, deviation_period_end)')
    .eq('company_id', args.companyId).in('employee_id', openings.map(row => row.employee_id))
    .in('salary_run.status', ['approved', 'paid', 'booked']).neq('salary_run.id', args.runId)
    .order('id').range(from, to)) as unknown as Array<VacationRunRow & { salary_run: RunWindow }>
  const cutoff = runDeviationWindow(args.run).end
  const payEnd = new Date(Date.UTC(args.run.period_year, args.run.period_month, 0)).toISOString().slice(0, 10)
  for (const row of openings) {
    const opening = VacationBalanceSchema.parse(row.vacation_balance)
    // A new starter can receive an initial grant in the pay month, after
    // the preceding-month deviation cutoff. Do not backdate that grant.
    if (opening.as_of_date > payEnd) continue
    const asOf = opening.as_of_date > cutoff ? opening.as_of_date : cutoff
    const movements: VacationMovement[] = []
    const collect = (employee: VacationRunRow, run: RunWindow) => {
      const window = runDeviationWindow(run)
      for (const line of employee.line_items ?? []) {
        const effects = line.vacation_movements ?? []
        if (effects.length) movements.push(...effects)
        else if (line.item_type === 'vacation' && (line.quantity ?? 0) > 0 &&
          line.calculation_source !== 'vacation_compensation' && window.end > opening.as_of_date && window.start <= asOf) {
          throw new Error('Semesteruttag efter ingångssaldot saknar datum och kategori')
        }
      }
    }
    for (const prior of previous) {
      if (prior.employee_id === row.employee_id &&
        prior.salary_run.period_year * 12 + prior.salary_run.period_month <= args.run.period_year * 12 + args.run.period_month) collect(prior, prior.salary_run)
    }
    const current = args.current.find(current => current.employee_id === row.employee_id)
    if (current) collect(current, args.run)
    result.set(row.employee_id, rollVacationBalance(opening, movements, asOf))
  }
  return result
}
