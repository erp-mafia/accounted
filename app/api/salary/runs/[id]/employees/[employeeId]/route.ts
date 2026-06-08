import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { validateBody } from '@/lib/api/validate'
import { SalaryEmployeeOverrideSchema } from '@/lib/api/schemas'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'

ensureInitialized()

/** Fetch one employee's pay spec within a salary run, with employee + line items. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> },
) {
  const { id, employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(*), line_items:salary_line_items(*)')
    .eq('salary_run_id', id)
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
  }

  // Strip the encrypted personnummer ciphertext before sending to the browser
  // — replace it with the YYYYMMDD-XXXX masked form so the page can render
  // identity without exposing the suffix or the raw cipher blob.
  const masked = {
    ...data,
    employee: data.employee
      ? {
          ...data.employee,
          personnummer: maskPersonnummer(decryptPersonnummer(data.employee.personnummer)),
        }
      : data.employee,
  }

  return NextResponse.json({ data: masked })
}

/**
 * Per-employee edits within a salary run. Two operations, gated to different
 * statuses (never combined in one request):
 *
 *  • monthly_salary — set this month's base salary for the employee. Allowed
 *    only in `draft`. 0 is valid (an intentional nollkörning). The engine reads
 *    this per-run value (not the employee master) when the run is calculated, so
 *    each month's gross can differ without touching the employee's standard pay.
 *
 *  • tax_withheld_override / avgifter_*_override — manual tax/avgifter
 *    adjustment (advanced mode). Allowed only in `review`: the engine has run
 *    but the run isn't approved/booked. After approval, vouchers and AGI lock in
 *    the effective values; further changes require correction flows. Pass `null`
 *    for any override field to clear it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> },
) {
  const { id, employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

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

  const { data: run } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!run) return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })

  // ── Draft-stage edit of this month's base salary ──
  if (wantsSalaryEdit) {
    if (run.status !== 'draft') {
      return NextResponse.json(
        { error: 'Månadslönen kan bara redigeras medan lönekörningen är ett utkast.' },
        { status: 400 },
      )
    }
    const monthly = Math.round((parsed.data.monthly_salary as number) * 100) / 100

    const { data: sre, error: sreErr } = await supabase
      .from('salary_run_employees')
      .update({ monthly_salary: monthly })
      .eq('salary_run_id', id)
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .select('id, employment_degree, salary_type, monthly_salary')
      .maybeSingle()

    if (sreErr) return NextResponse.json({ error: sreErr.message }, { status: 400 })
    if (!sre) {
      return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
    }

    // Keep the displayed 'Grundlön' line consistent with the new salary. This is
    // display-only — the engine recomputes baseSalary from monthly_salary at
    // calc time — but it avoids a stale row before the user clicks Beräkna.
    if (sre.salary_type === 'monthly') {
      const baseAmount = Math.round(monthly * (sre.employment_degree / 100) * 100) / 100
      await supabase
        .from('salary_line_items')
        .update({ amount: baseAmount })
        .eq('salary_run_employee_id', sre.id)
        .eq('company_id', companyId)
        .eq('item_type', 'monthly_salary')
    }

    return NextResponse.json({ data: sre })
  }

  // ── Review-stage override of tax/avgifter ──
  if (run.status !== 'review') {
    return NextResponse.json(
      { error: 'Justering av skatt/avgifter är bara tillåten i granskningsläge (review).' },
      { status: 400 },
    )
  }

  // Build patch — only include fields that were explicitly provided so
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
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
  }

  return NextResponse.json({ data })
}

/** Remove employee from a draft salary run. Cascades to delete their line items. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> }
) {
  const { id, employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Verify run is draft
  const { data: run } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!run) return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
  if (run.status !== 'draft') return NextResponse.json({ error: 'Kan bara redigera utkast' }, { status: 400 })

  // Delete the salary_run_employee (cascades to salary_line_items via ON DELETE CASCADE)
  const { error } = await supabase
    .from('salary_run_employees')
    .delete()
    .eq('salary_run_id', id)
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: { deleted: true } })
}
