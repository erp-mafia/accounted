import type { SupabaseClient } from '@supabase/supabase-js'
import type { MoneyLineItemType } from '@/lib/salary/account-mapping'

const BASE_LINE_TYPES: MoneyLineItemType[] = ['monthly_salary', 'hourly_salary']

/** The display line a pay type is shown with: Grundlön or Timlön. */
export function baseSalaryLineType(salaryType: string): MoneyLineItemType {
  return salaryType === 'monthly' ? 'monthly_salary' : 'hourly_salary'
}

/**
 * The monthly salary a run row starts from: the employee's for monthly pay,
 * none for hourly pay. Hourly gross is timlön x hours, so a monthly figure
 * still stored on an hourly employee (left from before a switch to timlön)
 * is never priced; copied onto the run row it only showed up as this run's
 * "Månadslön" next to colleagues paid the same timlön (crm#1337).
 */
export function runMonthlySalaryFor(employee: { salary_type: string; monthly_salary: number | null }): number {
  return employee.salary_type === 'monthly' ? employee.monthly_salary || 0 : 0
}

/**
 * Bring a DRAFT run row in line with the employee's current pay type.
 *
 * salary_run_employees.salary_type is a snapshot taken when the employee
 * joined the run. The calculation prices the employee's live salary_type, so
 * after an employee moved between hourly and monthly pay the snapshot (and
 * the Grundlön/Timlön display line seeded with it) went stale, and the
 * per-run salary command refused the field that matched the employee's real
 * pay type (agent feedback seq 869949). This swaps the base display line and
 * then rewrites the snapshot; the caller prices the new line (the engine
 * never reads it: gross comes from monthly_salary or rate x hours).
 *
 * The row's monthly salary is rewritten with the pay type (crm#1337): a row
 * that was hourly never had a monthly salary of its own (the per-run salary
 * command refreshes the pay type before it writes one), so a switch to
 * monthly pay takes the employee's, and a switch to hourly pay clears it.
 * Kept, the old figure priced a 0 kr Grundlön (or a salary from before the
 * last switch) without a word.
 *
 * Order is chosen so a failure part-way leaves a state the next call
 * repairs: the new line is inserted only if the row has none of that type,
 * the old line is deleted only after the new one exists, and the snapshot
 * is written last, so a row whose snapshot still differs is retried in
 * full and never ends up with no base line or with two.
 *
 * Draft runs only: an approved or booked run keeps the pay type it was
 * calculated and posted with.
 */
export async function refreshRunEmployeeSalaryType(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunEmployeeId: string
    salaryType: string
    /** The row's monthly salary under the new pay type (runMonthlySalaryFor). */
    monthlySalary: number
    /** Initial figures for the new display line. */
    amount: number
    quantity: number | null
    unitPrice: number | null
  },
): Promise<{ error: { message: string; code?: string } | null }> {
  const lineType = baseSalaryLineType(args.salaryType)

  const { data: existing, error: readError } = await supabase
    .from('salary_line_items')
    .select('id, item_type')
    .eq('salary_run_employee_id', args.salaryRunEmployeeId)
    .eq('company_id', args.companyId)
    .in('item_type', BASE_LINE_TYPES)
  if (readError) return { error: readError }

  const hasNewLine = ((existing ?? []) as Array<{ item_type: string }>).some((l) => l.item_type === lineType)
  if (!hasNewLine) {
    const { error: insError } = await supabase.from('salary_line_items').insert({
      salary_run_employee_id: args.salaryRunEmployeeId,
      company_id: args.companyId,
      item_type: lineType,
      description: args.salaryType === 'monthly' ? 'Grundlön' : 'Timlön',
      quantity: args.quantity,
      unit_price: args.unitPrice,
      amount: args.amount,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: true,
      account_number: null,
      sort_order: 0,
    })
    if (insError) return { error: insError }
  }

  const { error: delError } = await supabase
    .from('salary_line_items')
    .delete()
    .eq('salary_run_employee_id', args.salaryRunEmployeeId)
    .eq('company_id', args.companyId)
    .in('item_type', BASE_LINE_TYPES.filter((t) => t !== lineType))
  if (delError) return { error: delError }

  const { error: snapError } = await supabase
    .from('salary_run_employees')
    .update({ salary_type: args.salaryType, monthly_salary: args.monthlySalary })
    .eq('id', args.salaryRunEmployeeId)
    .eq('company_id', args.companyId)
  return { error: snapError }
}
