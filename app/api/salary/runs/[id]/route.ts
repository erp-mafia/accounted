import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'

ensureInitialized()

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.runs.get',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data: run, error } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    // Load employees with line items
    const { data: employees } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(id, first_name, last_name, personnummer, personnummer_last4, employment_type, default_dimensions), line_items:salary_line_items(*)')
      .eq('salary_run_id', id)
      .order('created_at')

    // Resolve Skatteverket arbetsgivare ID for AGI submission. We surface this
    // in the run payload so the client doesn't need a second round-trip just to
    // build extension URLs. Quietly null when the org number isn't set yet.
    let arbetsgivare: string | null = null
    const { data: settings } = await supabase
      .from('company_settings')
      .select('org_number, entity_type')
      .eq('company_id', companyId)
      .maybeSingle()
    if (settings?.org_number && settings?.entity_type) {
      try {
        arbetsgivare = formatRedovisare(settings.org_number, settings.entity_type)
      } catch {
        arbetsgivare = null
      }
    }

    return NextResponse.json({
      data: {
        ...run,
        arbetsgivare,
        employees: (employees || []).map(emp => ({
          ...emp,
          employee: emp.employee ? {
            ...emp.employee,
            personnummer: maskPersonnummer(decryptPersonnummer(emp.employee.personnummer)),
          } : null,
        })),
      },
    })
  },
)

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.runs.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Only allow updates on draft runs
    const { data: run, error: fetchError } = await supabase
      .from('salary_runs')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    if (run.status !== 'draft') {
      return NextResponse.json({ error: 'Kan bara redigera utkast' }, { status: 400 })
    }

    const body = await request.json()
    const allowedFields = ['payment_date', 'voucher_series', 'notes']
    const updates: Record<string, unknown> = {}
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field]
      }
    }

    const { data: updated, error } = await supabase
      .from('salary_runs')
      .update(updates)
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.runs.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Only draft runs can be deleted. Once a run reaches review/approved/paid/
    // booked it carries compliance weight: a booked run created immutable
    // verifikat (storno to undo, never delete). A draft has produced no journal
    // entries and no AGI (the arbetsgivardeklaration is filed monthly from the
    // booked/paid run, never from a draft), so removing it touches no posted
    // accounting data.
    const { data: run, error: fetchError } = await supabase
      .from('salary_runs')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    if (run.status !== 'draft') {
      return NextResponse.json(
        { error: 'Bara utkast kan raderas. En bokförd lönekörning måste vändas (storno).' },
        { status: 400 }
      )
    }

    // salary_run_employees and their salary_line_items are removed via
    // ON DELETE CASCADE. An agi_declarations row (never present on a draft)
    // would block the delete via its RESTRICT FK, the safety net for the
    // impossible case.
    const { error } = await supabase
      .from('salary_runs')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data: { id, deleted: true } })
  },
  { requireWrite: true },
)
