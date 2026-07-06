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

    // These five reads only depend on `run` (already fetched) + companyId, so
    // fire them concurrently — the detail GET is on the hot path for every
    // status transition, and serial round-trips dominated its latency.
    type PreviousRun = {
      id: string
      period_year: number
      period_month: number
      by_employee: Record<string, { gross: number; tax: number; net: number }>
    }

    const [employeesResult, settingsResult, previousRun, correctedByRunId, deliveriesResult] =
      await Promise.all([
        // Employees with line items. A failed embed here (e.g. a schema/column
        // mismatch on the joined tables) must surface — silently returning an
        // empty list makes the run look employee-less, which then lets the
        // client offer an already-added employee and get a confusing 409.
        supabase
          .from('salary_run_employees')
          .select('*, employee:employees(id, first_name, last_name, personnummer, personnummer_last4, employment_type, default_dimensions), line_items:salary_line_items(*)')
          .eq('salary_run_id', id)
          .order('created_at'),
        // Skatteverket arbetsgivare ID for AGI submission.
        supabase
          .from('company_settings')
          .select('org_number, entity_type')
          .eq('company_id', companyId)
          .maybeSingle(),
        // Latest booked run before this period — powers the Δ-vs-last-month
        // column. Effective values (overrides coalesced) so the diff matches
        // what was actually booked and AGI-reported.
        (async (): Promise<PreviousRun | null> => {
          const { data: prev } = await supabase
            .from('salary_runs')
            .select('id, period_year, period_month')
            .eq('company_id', companyId)
            .eq('status', 'booked')
            .or(
              `period_year.lt.${run.period_year},and(period_year.eq.${run.period_year},period_month.lt.${run.period_month})`,
            )
            .order('period_year', { ascending: false })
            .order('period_month', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (!prev) return null

          const { data: prevEmployees } = await supabase
            .from('salary_run_employees')
            .select('employee_id, gross_salary, tax_withheld, tax_withheld_override, net_salary')
            .eq('salary_run_id', prev.id)
            .eq('company_id', companyId)

          const byEmployee: Record<string, { gross: number; tax: number; net: number }> = {}
          for (const row of prevEmployees || []) {
            const effTax = row.tax_withheld_override ?? row.tax_withheld
            byEmployee[row.employee_id] = {
              gross: row.gross_salary,
              tax: effTax,
              net: row.net_salary + (row.tax_withheld - effTax),
            }
          }
          return {
            id: prev.id,
            period_year: prev.period_year,
            period_month: prev.period_month,
            by_employee: byEmployee,
          }
        })(),
        // Reverse correction link so corrected originals can point forward.
        (async (): Promise<string | null> => {
          if (run.status !== 'corrected') return null
          const { data: correction } = await supabase
            .from('salary_runs')
            .select('id')
            .eq('company_id', companyId)
            .eq('corrects_run_id', id)
            .limit(1)
            .maybeSingle()
          return correction?.id ?? null
        })(),
        // Latest payslip delivery per employee → counts for the Lönebesked step.
        supabase
          .from('salary_payslip_deliveries')
          .select('employee_id, status, sent_at')
          .eq('salary_run_id', id)
          .eq('company_id', companyId)
          .order('sent_at', { ascending: false }),
      ])

    const { data: employees, error: employeesError } = employeesResult
    if (employeesError) {
      return NextResponse.json(
        { error: `Kunde inte läsa anställda för lönekörningen: ${employeesError.message}` },
        { status: 500 },
      )
    }

    const settings = settingsResult.data
    let arbetsgivare: string | null = null
    if (settings?.org_number && settings?.entity_type) {
      try {
        arbetsgivare = formatRedovisare(settings.org_number, settings.entity_type)
      } catch {
        arbetsgivare = null
      }
    }

    const deliveries = deliveriesResult.data
    const latestByEmployee = new Map<string, string>()
    for (const d of deliveries || []) {
      if (!latestByEmployee.has(d.employee_id)) {
        latestByEmployee.set(d.employee_id, d.status)
      }
    }
    const deliveriesSummary = {
      sent: 0,
      failed: 0,
      skipped: 0,
      last_sent_at: deliveries?.[0]?.sent_at ?? null,
    }
    for (const status of latestByEmployee.values()) {
      if (status === 'sent' || status === 'delivered') deliveriesSummary.sent++
      else if (status === 'skipped') deliveriesSummary.skipped++
      else deliveriesSummary.failed++
    }

    return NextResponse.json({
      data: {
        ...run,
        arbetsgivare,
        previous_run: previousRun,
        corrected_by_run_id: correctedByRunId,
        payslip_deliveries_summary: deliveriesSummary,
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
