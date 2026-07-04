import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { eventBus } from '@/lib/events'
import { effectiveNetPayout } from '@/lib/salary/payment/effective-net'

ensureInitialized()

/** review → approved (authorization recorded, with pre-approve validation) */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.approve',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    // Verify run exists and is in review status
    const { data: run, error: runError } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'review')
      .single()

    if (runError || !run) {
      return NextResponse.json({ error: 'Lönekörningen måste vara i granskningsstatus' }, { status: 400 })
    }

    // Load all employees in this run for validation
    const { data: runEmployees } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(first_name, last_name, clearing_number, bank_account_number, email)')
      .eq('salary_run_id', id)

    const validationErrors: string[] = []
    const warnings: string[] = []

    for (const sre of runEmployees || []) {
      const emp = sre.employee as {
        first_name: string
        last_name: string
        clearing_number: string | null
        bank_account_number: string | null
        email: string | null
      } | null
      if (!emp) continue
      const name = `${emp.first_name} ${emp.last_name}`

      // Bank details are only required when there's an actual payout. A zero
      // net (nollkörning, or fully net-deducted) produces no payment-file line,
      // so no destination account is needed: mirrors the pain.001 / BG-LB
      // generators, which only include employees with effectiveNet > 0.
      if (effectiveNetPayout(sre) > 0 && (!emp.clearing_number || !emp.bank_account_number)) {
        validationErrors.push(`${name}: Bankuppgifter saknas (clearingnummer och/eller kontonummer)`)
      }

      // Must have been calculated (calculation_breakdown exists)
      if (!sre.calculation_breakdown) {
        validationErrors.push(`${name}: Beräkning saknas, kör beräkning först`)
      }

      // Warning: no email means pay slip cannot be sent
      if (!emp.email) {
        warnings.push(`${name}: E-post saknas, lönebesked kan inte skickas`)
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json({
        error: 'Valideringsfel: korrigera innan godkännande',
        details: validationErrors,
        warnings,
      }, { status: 400 })
    }

    // All validation passed: approve
    const { data: updatedRun, error } = await supabase
      .from('salary_runs')
      .update({
        status: 'approved',
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'review')
      .select()
      .single()

    if (error || !updatedRun) {
      return NextResponse.json({ error: 'Kunde inte godkänna lönekörningen' }, { status: 500 })
    }

    await eventBus.emit({
      type: 'salary_run.approved',
      payload: { salaryRunId: id, approvedBy: user.id, userId: user.id, companyId },
    })

    return NextResponse.json({ data: updatedRun, warnings })
  },
  { requireWrite: true },
)
