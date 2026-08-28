import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SalaryEmployeeOverrideSchema } from '@/lib/api/schemas'
import { maskEmployeeForResponse } from '@/lib/salary/personnummer'
import { removeEmployeeFromRun, setRunEmployeeSalary } from '@/lib/salary/run-employees'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/** Fetch one employee's pay spec within a salary run, with employee + line items. */
export const GET = withRouteContext<{ params: Promise<{ id: string; employeeId: string }> }>(
  'salary.run.employee.get',
  async (_request, ctx, { params }) => {
    const { id, employeeId } = await params
    const { supabase, companyId } = ctx

    const { data, error } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(*), line_items:salary_line_items(*)')
      .eq('salary_run_id', id)
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
    }

    // Strip the encrypted personnummer ciphertext AND personnummer_last4
    // before sending to the browser (the embed is employees(*), so the last4
    // column rides along otherwise, and mask + last4 reassembles the full
    // personnummer). The shared helper replaces both with the YYYYMMDD-XXXX
    // masked form under `personnummer_masked`, never under the writable
    // `personnummer` key: this payload is an employee object, and a mask under
    // the write key could be read here and posted straight back into the
    // encrypt path.
    const masked = {
      ...data,
      employee: data.employee ? maskEmployeeForResponse(data.employee) : data.employee,
    }

    return NextResponse.json({ data: masked })
  },
)

/**
 * Per-employee edits within a salary run. Two operations, gated to different
 * statuses (never combined in one request):
 *
 *  • monthly_salary: set this month's base salary for the employee. Allowed
 *    only in `draft`. 0 is valid (an intentional nollkörning). The engine reads
 *    this per-run value (not the employee master) when the run is calculated, so
 *    each month's gross can differ without touching the employee's standard pay.
 *
 *  • tax_withheld_override / avgifter_*_override: manual tax/avgifter
 *    adjustment (advanced mode). Allowed only in `review`: the engine has run
 *    but the run isn't approved/booked. After approval, vouchers and AGI lock in
 *    the effective values; further changes require correction flows. Pass `null`
 *    for any override field to clear it.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string; employeeId: string }> }>(
  'salary.run.employee.update',
  async (request, ctx, { params }) => {
    const { id, employeeId } = await params
    const { supabase, companyId } = ctx

    const parsed = await validateBody(request, SalaryEmployeeOverrideSchema)
    if (!parsed.success) return parsed.response

    // Two distinct operations share this endpoint, gated to different statuses:
    //   • monthly_salary  → edit this month's base salary (draft only)
    //   • *_override       → manual tax/avgifter adjustment (review only)
    // They must not be mixed in one request.
    const wantsSalaryEdit = parsed.data.monthly_salary !== undefined
    const wantsOverride =
      parsed.data.tax_withheld_override !== undefined ||
      parsed.data.avgifter_amount_override !== undefined ||
      parsed.data.avgifter_basis_override !== undefined ||
      parsed.data.reason !== undefined

    if (wantsSalaryEdit && wantsOverride) {
      return NextResponse.json(
        { error: 'Kan inte ändra månadslön och skatte-/avgiftsjustering i samma anrop.' },
        { status: 400 },
      )
    }

    // ── Draft-stage edit of this month's base salary ──
    // The shared service owns the run lookup + draft gate for this branch.
    if (wantsSalaryEdit) {
      const result = await setRunEmployeeSalary(supabase, {
        companyId,
        salaryRunId: id,
        employeeId,
        monthlySalary: parsed.data.monthly_salary as number,
      })

      if (!result.ok) {
        if (result.code === 'SALARY_RUN_NOT_FOUND') {
          return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
        }
        if (result.code === 'SALARY_RUN_EMPLOYEES_NOT_DRAFT') {
          return NextResponse.json(
            { error: 'Månadslönen kan bara redigeras medan lönekörningen är ett utkast.' },
            { status: 400 },
          )
        }
        if (result.code === 'SALARY_RUN_EMPLOYEE_NOT_FOUND') {
          return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
        }
        return NextResponse.json({ error: getUserErrorMessage(result.details) }, { status: 400 })
      }

      // Same response shape as before the lift into lib/salary/run-employees.
      return NextResponse.json({
        data: {
          id: result.data.salary_run_employee_id,
          employment_degree: result.data.employment_degree,
          salary_type: result.data.salary_type,
          monthly_salary: result.data.monthly_salary,
        },
      })
    }

    const { data: run } = await supabase
      .from('salary_runs')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!run) return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })

    // ── Review-stage override of tax/avgifter ──
    if (run.status !== 'review') {
      return NextResponse.json(
        { error: 'Justering av skatt/avgifter är bara tillåten i granskningsläge (review).' },
        { status: 400 },
      )
    }

    // Build patch: only include fields that were explicitly provided so
    // unrelated overrides are not nulled.
    const patch: Record<string, number | string | null> = {}
    if ('tax_withheld_override' in parsed.data) {
      patch.tax_withheld_override = parsed.data.tax_withheld_override ?? null
    }
    if ('avgifter_amount_override' in parsed.data) {
      patch.avgifter_amount_override = parsed.data.avgifter_amount_override ?? null
    }
    if ('avgifter_basis_override' in parsed.data) {
      patch.avgifter_basis_override = parsed.data.avgifter_basis_override ?? null
    }
    if ('reason' in parsed.data) {
      patch.override_reason = parsed.data.reason ?? null
    }

    const { data, error } = await supabase
      .from('salary_run_employees')
      .update(patch)
      .eq('salary_run_id', id)
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .select('id, tax_withheld, tax_withheld_override, avgifter_amount, avgifter_amount_override, avgifter_basis, avgifter_basis_override, override_reason')
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 400 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

/** Remove employee from a draft salary run. Cascades to delete their line items. */
export const DELETE = withRouteContext<{ params: Promise<{ id: string; employeeId: string }> }>(
  'salary.run.employee.delete',
  async (_request, ctx, { params }) => {
    const { id, employeeId } = await params
    const { supabase, companyId } = ctx

    const result = await removeEmployeeFromRun(supabase, {
      companyId,
      salaryRunId: id,
      employeeId,
    })

    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return NextResponse.json(
        { error: entry?.message_sv ?? 'Något gick fel', code: result.code },
        { status: entry?.httpStatus ?? 500 },
      )
    }

    return NextResponse.json({ data: { deleted: true } })
  },
  { requireWrite: true },
)
