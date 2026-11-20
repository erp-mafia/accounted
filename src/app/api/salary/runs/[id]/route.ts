import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { companyRedovisare } from '@/lib/company/org-number'
import { maskEmployeeForResponse } from '@/lib/salary/personnummer'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { updateDraftSalaryRun, type SalaryRunHeaderPatch } from '@/lib/salary/update-run'
import { deleteDraftSalaryRun } from '@/lib/salary/delete-run'

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.runs.get',
  async (_request, { supabase, companyId, log }, { params }) => {
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
    // fire them concurrently - the detail GET is on the hot path for every
    // status transition, and serial round-trips dominated its latency.
    type PreviousRun = {
      id: string
      period_year: number
      period_month: number
      by_employee: Record<string, { gross: number; tax: number; net: number }>
    }

    const [employeesResult, arbetsgivare, previousRun, correctedByRunId, deliveriesResult] =
      await Promise.all([
        // Employees with line items. A failed embed here (e.g. a schema/column
        // mismatch on the joined tables) must surface - silently returning an
        // empty list makes the run look employee-less, which then lets the
        // client offer an already-added employee and get a confusing 409.
        supabase
          .from('salary_run_employees')
          .select('*, employee:employees(id, first_name, last_name, personnummer, employment_type, default_dimensions, f_skatt_status, salary_type, monthly_salary, hourly_rate, employment_degree, fora_fok_id), line_items:salary_line_items(*)')
          .eq('salary_run_id', id)
          .order('created_at'),
        // Skatteverket arbetsgivare ID for AGI submission. A number that does
        // not convert leaves the page without one, logged: AGI answers that itself.
        companyRedovisare(supabase, companyId).catch((err: unknown) => {
          log.warn('arbetsgivare id unavailable', { error: err instanceof Error ? err.message : String(err) })
          return null
        }),
        // Latest booked run before this period - powers the Δ-vs-last-month
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
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const body = await request.json().catch(() => null)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Ogiltig förfrågan' }, { status: 400 })
    }
    // Only these three fields ever reach the service; the value rules, the
    // draft-only guard, the optimistic lock and the calculation clear on a
    // supplied payment_date are lib/salary/update-run.ts, shared with the v1
    // PATCH and the MCP update tool.
    const patch: SalaryRunHeaderPatch = {}
    if (body.payment_date !== undefined) patch.payment_date = body.payment_date
    if (body.voucher_series !== undefined) patch.voucher_series = body.voucher_series
    if (body.notes !== undefined) patch.notes = body.notes

    const result = await updateDraftSalaryRun(supabase, {
      companyId: companyId!,
      salaryRunId: id,
      patch,
      columns: '*',
    })
    if (!result.ok) {
      if (result.code === 'INTERNAL_ERROR') {
        log.error('salary run update failed', new Error(String(result.details?.message)), { salaryRunId: id })
        return NextResponse.json({ error: 'Lönekörningen kunde inte uppdateras' }, { status: 500 })
      }
      const messageSv = result.details?.message_sv as string | undefined
      return errorResponseFromCode(result.code, log, {
        requestId,
        details: result.details,
        ...(messageSv ? { messageSv, messageEn: result.details?.message as string } : {}),
      })
    }

    return NextResponse.json({ data: result.data.row })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.runs.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Only draft runs can be deleted: past draft the run carries compliance
    // weight and storno is the only way back. The guarded write (status lock
    // plus null journal-entry FKs) lives in lib/salary/delete-run.ts, shared
    // with the v1 DELETE.
    const result = await deleteDraftSalaryRun(supabase, { companyId, salaryRunId: id })

    if (!result.ok) {
      switch (result.code) {
        case 'SALARY_RUN_NOT_FOUND':
          return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
        case 'DB_ERROR':
          return NextResponse.json({ error: getUserErrorMessage(result.error) }, { status: 500 })
        default:
          // Not a draft, or it left draft (or got a verifikat) after the check.
          return NextResponse.json(
            { error: 'Bara utkast kan raderas. En bokförd lönekörning måste vändas (storno).' },
            { status: 400 }
          )
      }
    }

    return NextResponse.json({ data: { id, deleted: true } })
  },
  { requireWrite: true },
)
