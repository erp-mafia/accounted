import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody, validateQuery } from '@/lib/api/validate'
import {
  UpsertAbsenceDaySchema,
  AbsenceRangeQuerySchema,
  AbsenceTypeSchema,
} from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

ensureInitialized()

async function loadEmployee(
  supabase: Awaited<ReturnType<typeof createClient>>,
  employeeId: string,
  companyId: string,
) {
  const { data } = await supabase
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()
  return data
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const employee = await loadEmployee(supabase, employeeId, companyId)
  if (!employee) {
    return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
  }

  const query = validateQuery(request, AbsenceRangeQuerySchema)
  if (!query.success) return query.response

  const { data, error } = await supabase
    .from('salary_absence_days')
    .select('id, absence_date, absence_type, hours, notes, salary_run_employee_id, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .gte('absence_date', query.data.from)
    .lte('absence_date', query.data.to)
    .order('absence_date', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
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

  const employee = await loadEmployee(supabase, employeeId, companyId)
  if (!employee) {
    return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
  }

  const validation = await validateBody(request, UpsertAbsenceDaySchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Upsert via DELETE+INSERT on the natural key (employee, date, type) so the
  // notes/hours/run-link can be replaced cleanly. The unique index makes ON
  // CONFLICT viable too, but Supabase's typed client doesn't expose
  // onConflict for our composite key without a named constraint name:
  // delete-then-insert keeps the pattern consistent with token-store.ts.
  const { error: deleteError } = await supabase
    .from('salary_absence_days')
    .delete()
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('absence_date', body.absence_date)
    .eq('absence_type', body.absence_type)

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('salary_absence_days')
    .insert({
      company_id: companyId,
      employee_id: employeeId,
      absence_date: body.absence_date,
      absence_type: body.absence_type,
      hours: body.hours,
      notes: body.notes ?? null,
      salary_run_employee_id: body.salary_run_employee_id ?? null,
    })
    .select()
    .single()

  if (error) {
    // The 24h cap trigger raises check_violation when worked + absence > 24h
    // for the same date. Surface a clean 409 with the Swedish message.
    if (error.message?.includes('Total tid') || error.code === '23514') {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data }, { status: 201 })
}

// Two modes: ?date=YYYY-MM-DD&type=... (single row) or ?from=…&to=… (range).
// We don't reuse AbsenceRangeQuerySchema.partial() because Zod refuses
// `.partial()` on a schema with refinements (the from<=to check).
const DeleteQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  date: isoDate.optional(),
  type: AbsenceTypeSchema.optional(),
})

export async function DELETE(
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

  const employee = await loadEmployee(supabase, employeeId, companyId)
  if (!employee) {
    return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
  }

  const query = validateQuery(request, DeleteQuerySchema)
  if (!query.success) return query.response
  const { date, type, from, to } = query.data

  // Two delete modes: a single (date, type) row, or a date range.
  const hasSingle = !!date
  const hasRange = !!from && !!to
  if (!hasSingle && !hasRange) {
    return NextResponse.json(
      { error: 'Ange antingen ?date=YYYY-MM-DD&type=... eller ?from=...&to=...' },
      { status: 400 },
    )
  }

  let q = supabase
    .from('salary_absence_days')
    .delete()
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)

  if (hasSingle) {
    q = q.eq('absence_date', date!)
    if (type) q = q.eq('absence_type', type)
  } else {
    q = q.gte('absence_date', from!).lte('absence_date', to!)
    if (type) q = q.eq('absence_type', type)
  }

  const { error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: { ok: true } })
}
