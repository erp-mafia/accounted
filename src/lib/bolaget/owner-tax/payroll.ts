/**
 * The löneunderlag for K10 from the payroll in Accounted: the kontant
 * bruttolön paid in a calendar year (IL 57:17 as amended: cash pay to the
 * employees the year before the inkomstår; benefits and expense
 * reimbursements are not cash pay).
 *
 * Per payslip the figure is salary_run_employees.gross_salary, the same
 * figure the AGI declares as kontant ersättning (FK011). A run counts when
 * its pay is authorised (approved, paid or booked, as the payslip's
 * year-to-date) and its betalningsdag is in the year; a corrected run is
 * replaced by its correction. Left out: payees with F-skatt (not
 * employees) and payslips taken out of the AGI. A cutover opening balance
 * (pay from an earlier program) dated in the year adds its year-to-date
 * gross.
 *
 * Read straight from the payroll tables: owner tax does not depend on the
 * payroll module, it only reads what it booked.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/** Run statuses whose pay counts (lib/salary/ytd.ts YTD_COUNTED_STATUSES). */
const COUNTED_RUN_STATUSES = ['approved', 'paid', 'booked'] as const

export interface PayrollEmployeePay {
  employee_id: string
  name: string
  amount: number
}

export interface PayrollYear {
  year: number
  total: number
  runs: number
  /** Year-to-date gross from cutover opening balances dated in the year. */
  opening_balance_amount: number
  employees: PayrollEmployeePay[]
}

export async function loadPayrollCashPay(supabase: SupabaseClient, companyId: string, year: number): Promise<PayrollYear> {
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const runs = (await fetchAllRows(({ from: start, to: end }) =>
    supabase
      .from('salary_runs')
      .select('id, payment_date, status')
      .eq('company_id', companyId)
      .in('status', [...COUNTED_RUN_STATUSES])
      .gte('payment_date', from)
      .lte('payment_date', to)
      .order('id')
      .range(start, end),
  )) as Array<{ id: string; payment_date: string; status: string }>

  const byEmployee = new Map<string, number>()
  if (runs.length > 0) {
    const slips = (await fetchAllRows(({ from: start, to: end }) =>
      supabase
        .from('salary_run_employees')
        .select('id, salary_run_id, employee_id, gross_salary, removed_from_agi')
        .eq('company_id', companyId)
        .in('salary_run_id', runs.map((r) => r.id))
        .order('id')
        .range(start, end),
    )) as Array<{ id: string; salary_run_id: string; employee_id: string; gross_salary: number | string; removed_from_agi: boolean | null }>
    for (const s of slips) {
      if (s.removed_from_agi) continue
      byEmployee.set(s.employee_id, roundOre((byEmployee.get(s.employee_id) ?? 0) + Number(s.gross_salary || 0)))
    }
  }

  const opening = (await fetchAllRows(({ from: start, to: end }) =>
    supabase
      .from('employee_opening_balances')
      .select('id, employee_id, cutover_date, ytd_gross')
      .eq('company_id', companyId)
      .gte('cutover_date', from)
      .lte('cutover_date', to)
      .order('id')
      .range(start, end),
  )) as Array<{ id: string; employee_id: string; cutover_date: string; ytd_gross: number | string }>
  let openingAmount = 0
  for (const o of opening) {
    const gross = Number(o.ytd_gross || 0)
    if (gross <= 0) continue
    openingAmount = roundOre(openingAmount + gross)
    byEmployee.set(o.employee_id, roundOre((byEmployee.get(o.employee_id) ?? 0) + gross))
  }

  const ids = [...byEmployee.keys()]
  const people = new Map<string, { first_name: string; last_name: string; f_skatt_status: string | null }>()
  if (ids.length > 0) {
    const { data, error } = await supabase.from('employees').select('id, first_name, last_name, f_skatt_status').eq('company_id', companyId).in('id', ids)
    if (error) throw new Error(`employees read failed: ${error.message}`)
    for (const e of (data ?? []) as Array<{ id: string; first_name: string; last_name: string; f_skatt_status: string | null }>) people.set(e.id, e)
  }

  const employees: PayrollEmployeePay[] = []
  for (const [employeeId, amount] of byEmployee) {
    const person = people.get(employeeId)
    // A payee with F-skatt is no employee: the pay is not löneunderlag.
    if (person?.f_skatt_status === 'f_skatt') continue
    if (amount <= 0) continue
    employees.push({ employee_id: employeeId, name: person ? `${person.first_name} ${person.last_name}`.trim() : '', amount })
  }
  employees.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'sv'))
  return {
    year,
    total: roundOre(employees.reduce((n, e) => n + e.amount, 0)),
    runs: runs.length,
    opening_balance_amount: openingAmount,
    employees,
  }
}

/** Case- and space-insensitive name key for matching an employee to a register person. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ').trim()
}

/** The payroll pay of the employees whose name is the person's: the owner's own cash pay. */
export function ownPayFromPayroll(payroll: PayrollYear, personName: string): { amount: number; employees: PayrollEmployeePay[] } {
  const key = nameKey(personName)
  const matched = key ? payroll.employees.filter((e) => nameKey(e.name) === key) : []
  return { amount: roundOre(matched.reduce((n, e) => n + e.amount, 0)), employees: matched }
}
