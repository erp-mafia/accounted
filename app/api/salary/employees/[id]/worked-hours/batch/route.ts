import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BatchUpsertWorkedDaysSchema } from '@/lib/api/schemas'

ensureInitialized()

interface BatchConflict {
  date: string
  reason: string
}

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.batch',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const { data: employee } = await supabase
      .from('employees')
      .select('id')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!employee) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    const validation = await validateBody(request, BatchUpsertWorkedDaysSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Dedupe dates so the user can pass an array with accidental duplicates
    // (e.g. shift-clicking over the same date twice).
    const uniqueDates = Array.from(new Set(body.dates))

    // Bulk delete existing rows on these dates first so the per-row insert step
    // is a clean replace. Stays within RLS via company_id + employee_id filter.
    const { error: deleteError } = await supabase
      .from('salary_worked_days')
      .delete()
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .in('work_date', uniqueDates)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    // Per-row insert so we can isolate trigger failures (24h cap on a date with
    // existing absence) without aborting the whole batch. A single multi-row
    // insert would fail-fast and surface only the first conflict.
    const conflicts: BatchConflict[] = []
    let inserted = 0

    for (const date of uniqueDates) {
      const { error } = await supabase
        .from('salary_worked_days')
        .insert({
          company_id: companyId,
          employee_id: employeeId,
          work_date: date,
          hours: body.hours,
          notes: body.notes ?? null,
          salary_run_employee_id: body.salary_run_employee_id ?? null,
        })
      if (error) {
        // 24h cap trigger uses ERRCODE check_violation (23514) and a Swedish
        // message starting with "Total tid". Other failures are unexpected.
        if (error.message?.includes('Total tid') || error.code === '23514') {
          conflicts.push({ date, reason: error.message })
          continue
        }
        return NextResponse.json(
          { error: error.message, inserted, conflicts },
          { status: 500 },
        )
      }
      inserted += 1
    }

    return NextResponse.json(
      { data: { inserted, conflicts } },
      { status: conflicts.length > 0 ? 207 : 201 },
    )
  },
  { requireWrite: true },
)
