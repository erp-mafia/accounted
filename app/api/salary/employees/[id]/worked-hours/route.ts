import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import {
  UpsertWorkedDaySchema,
  WorkedHoursRangeQuerySchema,
} from '@/lib/api/schemas'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

ensureInitialized()

async function loadEmployee(
  supabase: SupabaseClient,
  employeeId: string,
  companyId: string,
) {
  const { data } = await supabase
    .from('employees')
    .select('id, salary_type')
    .eq('id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()
  return data
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.list',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const employee = await loadEmployee(supabase, employeeId, companyId)
    if (!employee) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    const query = validateQuery(request, WorkedHoursRangeQuerySchema)
    if (!query.success) return query.response

    const { data, error } = await supabase
      .from('salary_worked_days')
      .select('id, work_date, hours, notes, salary_run_employee_id, created_at, updated_at')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .gte('work_date', query.data.from)
      .lte('work_date', query.data.to)
      .order('work_date', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const totalHours = (data ?? []).reduce(
      (sum, d) => Math.round((sum + Number(d.hours)) * 100) / 100,
      0,
    )

    return NextResponse.json({ data, total_hours: totalHours })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.upsert',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const employee = await loadEmployee(supabase, employeeId, companyId)
    if (!employee) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    const validation = await validateBody(request, UpsertWorkedDaySchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Upsert via DELETE+INSERT on the natural key (employee, date). Worked days
    // have one row per date: re-marking overwrites. Mirrors the absence route's
    // pattern so behaviour stays predictable across the two calendars.
    const { error: deleteError } = await supabase
      .from('salary_worked_days')
      .delete()
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .eq('work_date', body.work_date)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    const { data, error } = await supabase
      .from('salary_worked_days')
      .insert({
        company_id: companyId,
        employee_id: employeeId,
        work_date: body.work_date,
        hours: body.hours,
        notes: body.notes ?? null,
        salary_run_employee_id: body.salary_run_employee_id ?? null,
      })
      .select()
      .single()

    if (error) {
      // The 24h cap trigger raises check_violation when worked + absence > 24h
      // for the same date. Surface a clean 409 with a Swedish message.
      if (error.message?.includes('Total tid') || error.code === '23514') {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data }, { status: 201 })
  },
  { requireWrite: true },
)

// Two modes: ?date=YYYY-MM-DD (single row) or ?from=…&to=… (range).
const DeleteQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  date: isoDate.optional(),
})

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.worked_hours.delete',
  async (request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const employee = await loadEmployee(supabase, employeeId, companyId)
    if (!employee) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    const query = validateQuery(request, DeleteQuerySchema)
    if (!query.success) return query.response
    const { date, from, to } = query.data

    const hasSingle = !!date
    const hasRange = !!from && !!to
    if (!hasSingle && !hasRange) {
      return NextResponse.json(
        { error: 'Ange antingen ?date=YYYY-MM-DD eller ?from=...&to=...' },
        { status: 400 },
      )
    }

    let q = supabase
      .from('salary_worked_days')
      .delete()
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)

    if (hasSingle) {
      q = q.eq('work_date', date!)
    } else {
      q = q.gte('work_date', from!).lte('work_date', to!)
    }

    const { error } = await q
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data: { ok: true } })
  },
  { requireWrite: true },
)
