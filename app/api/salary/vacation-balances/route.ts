import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { roundOre } from '@/lib/money'

ensureInitialized()

/** Open vacation-ledger rows joined with employee names, for the salary
 * dashboard's Semester card. Empty until the first booking seeds the ledger
 * (payroll gap-closure 3.5). */
export const GET = withRouteContext(
  'salary.vacation-balances.list',
  async (_request, { supabase, companyId }) => {
    const { data, error } = await supabase
      .from('employee_vacation_balances')
      .select(
        'id, employee_id, vacation_year_start, entitled_days, accrued_days, taken_days, saved_days, forced_payout_days, employee:employees(first_name, last_name, is_active)',
      )
      .eq('company_id', companyId)
      .eq('status', 'open')
      .order('vacation_year_start', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const rows = ((data ?? []) as Array<Record<string, unknown>>)
      .filter((r) => (r.employee as { is_active?: boolean } | null)?.is_active !== false)
      .map((r) => {
        const employee = r.employee as { first_name: string; last_name: string } | null
        const savedDays = (r.saved_days as Record<string, number> | null) ?? {}
        const entitled = (r.entitled_days as number) ?? 0
        const taken = (r.taken_days as number) ?? 0
        return {
          employee_vacation_balance_id: r.id,
          employee_id: r.employee_id,
          employee_name: employee ? `${employee.first_name} ${employee.last_name}` : '',
          vacation_year_start: r.vacation_year_start,
          entitled_days: entitled,
          taken_days: taken,
          remaining_days: roundOre(entitled - taken),
          saved_days_total: Object.values(savedDays).reduce((s, d) => s + (Number(d) || 0), 0),
          forced_payout_days: r.forced_payout_days ?? 0,
        }
      })

    return NextResponse.json({ data: rows })
  },
)
