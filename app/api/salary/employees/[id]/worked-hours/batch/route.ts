import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { BatchUpsertWorkedDaysSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

interface BatchConflict {
  date: string
  reason: string
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

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
        hourly_rate: body.hourly_rate ?? null,
        notes: body.notes ?? null,
        salary_run_employee_id: body.salary_run_employee_id ?? null,
        cost_center_id: body.cost_center_id ?? null,
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
}
