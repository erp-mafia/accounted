import type { SupabaseClient } from '@supabase/supabase-js'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import type { SalaryLineItemType } from '@/types'

const BASE_LINE_TYPES: SalaryLineItemType[] = ['monthly_salary', 'hourly_salary']

/** The display line a pay type is shown with: Grundlön or Timlön. */
export function baseSalaryLineType(salaryType: string): SalaryLineItemType {
  return salaryType === 'monthly' ? 'monthly_salary' : 'hourly_salary'
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
    employmentType: string
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
      account_number: getLineItemAccount(lineType, args.employmentType),
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
    .update({ salary_type: args.salaryType })
    .eq('id', args.salaryRunEmployeeId)
    .eq('company_id', args.companyId)
  return { error: snapError }
}
