import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { maskEmployeeForResponse } from '@/lib/salary/personnummer'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { ISO_DATE_RE } from '@/lib/invariants'

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
          .select('*, employee:employees(id, first_name, last_name, personnummer, employment_type, default_dimensions), line_items:salary_line_items(*)')
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
        { error: `Kunde inte läsa anställda för lönekörningen: ${getUserErrorMessage(employeesError)}` },
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
        // maskEmployeeForResponse drops the ciphertext and personnummer_last4
        // from every embedded employee, exposing only `personnummer_masked`.
        employees: (employees || []).map(emp => ({
          ...emp,
          employee: emp.employee ? maskEmployeeForResponse(emp.employee) : null,
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
      .select('id, status, payment_date, period_year, period_month')
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
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Ogiltig förfrågan' }, { status: 400 })
    }
    // Whitelist keys AND values: only these three fields, with the same value
    // rules as the v1 UpdateSalaryRunSchema, ever reach the DB.
    const allowedFields = ['payment_date', 'voucher_series', 'notes']
    const updates: Record<string, unknown> = {}
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field]
      }
    }
    if (
      updates.payment_date !== undefined &&
      (typeof updates.payment_date !== 'string' || !ISO_DATE_RE.test(updates.payment_date))
    ) {
      return NextResponse.json({ error: 'Ogiltigt datum (ÅÅÅÅ-MM-DD)' }, { status: 400 })
    }
    if (
      updates.voucher_series !== undefined &&
      (typeof updates.voucher_series !== 'string' || !/^[A-Z]$/.test(updates.voucher_series))
    ) {
      return NextResponse.json(
        { error: 'Verifikationsserie måste vara en bokstav A-Z' },
        { status: 400 },
      )
    }
    if (
      updates.notes !== undefined &&
      updates.notes !== null &&
      (typeof updates.notes !== 'string' || updates.notes.length > 2000)
    ) {
      return NextResponse.json({ error: 'Anteckningen får vara högst 2000 tecken' }, { status: 400 })
    }

    // Kontantprincipen guard (SFL 26 kap): the AGI derives its
    // redovisningsperiod from period_year/period_month while the verifikat
    // books on payment_date, so a payment date outside the run's period month
    // would post the entries in one month and declare them in another. Same
    // rule as lib/salary/update-run.ts and the v1 PATCH, including the
    // grandfather clause: a run created with an out-of-period payment date
    // may still be day-adjusted within that same month.
    if (typeof updates.payment_date === 'string') {
      const periodPrefix = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
      const newMonth = updates.payment_date.slice(0, 7)
      const currentMonth = String(run.payment_date).slice(0, 7)
      if (newMonth !== periodPrefix && newMonth !== currentMonth) {
        return NextResponse.json(
          {
            error:
              'Utbetalningsdagen måste ligga i lönekörningens period: AGI redovisas per utbetalningsmånad.',
          },
          { status: 400 },
        )
      }
    }

    // Optimistic lock on status='draft': a concurrent step advancing the run
    // (Beräkna → Till granskning in another tab) between the fetch above and
    // this write must fail the write, not slip a frozen-field edit through
    // (same guard as the v1 PATCH and lib/salary/update-run.ts).
    const { data: updated, error } = await supabase
      .from('salary_runs')
      .update(updates)
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .select()
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }
    if (!updated) {
      // Race: the run advanced past draft between fetch and update.
      return NextResponse.json({ error: 'Kan bara redigera utkast' }, { status: 400 })
    }

    // A supplied payment_date invalidates any existing calculation:
    // skatteavdrag follows the payment date, so clearing calculation_breakdown
    // makes both book preflights refuse the roster until a recalculation has
    // run against the new date (same invariant as setRunEmployeeSalary in
    // lib/salary/run-employees.ts and lib/salary/update-run.ts). Gated on
    // SUPPLIED, not on changed, so a retry after a partial failure re-clears
    // instead of comparing against the already-updated date and skipping.
    if (updates.payment_date !== undefined) {
      const { error: clearError } = await supabase
        .from('salary_run_employees')
        .update({ calculation_breakdown: null })
        .eq('salary_run_id', id)
        .eq('company_id', companyId)
      if (clearError) {
        return NextResponse.json({ error: getUserErrorMessage(clearError) }, { status: 500 })
      }
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
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data: { id, deleted: true } })
  },
  { requireWrite: true },
)
