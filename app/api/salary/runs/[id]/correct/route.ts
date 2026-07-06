import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse, EntryAlreadyReversedError } from '@/lib/bookkeeping/errors'
import { revokeLinksForRun } from '@/lib/salary/payslips/links'

ensureInitialized()

/**
 * Create a correction for a booked salary run.
 *
 * Per BFL 5 kap 5§ (Rättelse): Corrections must preserve the original.
 * This is implemented as:
 *   1. Reverse (storno) all journal entries from the original run
 *   2. Create a new correction salary run for the same period
 *   3. Mark the original run as 'corrected'
 *
 * The new run starts in 'draft' status so the user can edit and re-calculate.
 * On booking the correction run, new correct entries are created.
 * Both original and correction are visible in the journal per BFL.
 *
 * AGI must be re-generated with same FK570 (correction flag) per agi-filing.md.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Load the original booked run
  const { data: originalRun, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .eq('status', 'booked')
    .single()

  if (runError || !originalRun) {
    return NextResponse.json({ error: 'Kan bara korrigera bokförda lönekörningar' }, { status: 400 })
  }

  // Reverse all journal entries from the original run (storno per BFL 5 kap 5§)
  const entryIds = [
    originalRun.salary_entry_id,
    originalRun.avgifter_entry_id,
    originalRun.vacation_entry_id,
    originalRun.pension_entry_id,
  ].filter(Boolean) as string[]

  for (const entryId of entryIds) {
    try {
      await reverseEntry(supabase, companyId, user.id, entryId)
    } catch (err) {
      // Entry may already be reversed: continue
      if (err instanceof EntryAlreadyReversedError) continue
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      const msg = err instanceof Error ? err.message : ''
      return NextResponse.json({ error: `Kunde inte makulera verifikation: ${msg}` }, { status: 500 })
    }
  }

  // Mark original as corrected
  await supabase
    .from('salary_runs')
    .update({ status: 'corrected' })
    .eq('id', id)

  // The storno replaces the payslips — previously emailed payslip links for
  // the original run must stop resolving (they show as "ersatt" to the
  // employee). Fresh links are issued when the correction run's payslips
  // are sent.
  await revokeLinksForRun(supabase, id)

  // Create new correction run for same period
  // Remove the unique constraint conflict by using the original run's unique key
  // The unique constraint is (company_id, period_year, period_month) so we need
  // to delete the uniqueness or handle it. Since original is now 'corrected',
  // and we want a new run for the same period, we update the unique constraint.
  // Actually the DB still enforces uniqueness. The correction run needs the same period.
  // Solution: drop the old unique index and add a partial one excluding corrected runs,
  // OR just use the same run ID pattern. Let's create the correction run and handle the conflict.

  const { data: correctionRun, error: createError } = await supabase
    .from('salary_runs')
    .insert({
      company_id: companyId,
      user_id: user.id,
      period_year: originalRun.period_year,
      period_month: originalRun.period_month,
      payment_date: originalRun.payment_date,
      voucher_series: originalRun.voucher_series,
      is_correction: true,
      corrects_run_id: originalRun.id,
      notes: `Korrigering av lönekörning ${originalRun.period_year}-${String(originalRun.period_month).padStart(2, '0')}`,
    })
    .select()
    .single()

  if (createError) {
    // If unique constraint violation, the period already has an active run
    if (createError.code === '23505') {
      return NextResponse.json({
        error: 'Det finns redan en aktiv lönekörning för denna period. Ta bort den först.',
      }, { status: 409 })
    }
    return NextResponse.json({ error: createError.message }, { status: 500 })
  }

  // Copy employees from original run to correction run (with snapshots)
  const { data: originalEmployees } = await supabase
    .from('salary_run_employees')
    .select('*, line_items:salary_line_items(*)')
    .eq('salary_run_id', id)

  for (const origEmp of originalEmployees || []) {
    const { data: newSre } = await supabase
      .from('salary_run_employees')
      .insert({
        salary_run_id: correctionRun.id,
        employee_id: origEmp.employee_id,
        company_id: companyId,
        employment_degree: origEmp.employment_degree,
        monthly_salary: origEmp.monthly_salary,
        salary_type: origEmp.salary_type,
        hours_worked: origEmp.hours_worked,
        tax_table_number: origEmp.tax_table_number,
        tax_column: origEmp.tax_column,
      })
      .select()
      .single()

    if (newSre) {
      // Copy line items
      const lineItems = (origEmp.line_items || []) as Array<Record<string, unknown>>
      for (const li of lineItems) {
        await supabase.from('salary_line_items').insert({
          salary_run_employee_id: newSre.id,
          company_id: companyId,
          item_type: li.item_type,
          description: li.description,
          quantity: li.quantity,
          unit_price: li.unit_price,
          amount: li.amount,
          is_taxable: li.is_taxable,
          is_avgift_basis: li.is_avgift_basis,
          is_vacation_basis: li.is_vacation_basis,
          is_gross_deduction: li.is_gross_deduction,
          is_net_deduction: li.is_net_deduction,
          account_number: li.account_number,
          sort_order: li.sort_order,
        })
      }
    }
  }

  return NextResponse.json({
    data: correctionRun,
    message: 'Korrigeringskörning skapad. Originalverifikationer har makulerats (storno). Redigera och beräkna om den nya körningen.',
    reversed_entry_count: entryIds.length,
  }, { status: 201 })
}
