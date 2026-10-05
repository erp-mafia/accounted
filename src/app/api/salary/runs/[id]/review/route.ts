import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { rosterRowsWithoutCalculation, runCalculationState } from '@/lib/salary/calculation-state'

ensureInitialized()

function notDraftResponse() {
  return NextResponse.json({ error: 'Lönekörningen måste vara i utkaststatus' }, { status: 400 })
}

/**
 * draft → review (freeze calculations)
 *
 * Only a run whose calculation is current is frozen: the rule the run page
 * shows and the approve step enforces (lib/salary/calculation-state.ts). A
 * payment date, salary or roster change after the calculation used to pass
 * straight through here, and the run then stuck in review: approval refused
 * it as "Beräkning saknas", and a run in review cannot be calculated
 * (crm#1001).
 *
 * Per f-skatt.md: Employer must verify F-skatt status before first payment.
 * If any employee has f_skatt_status = 'not_verified', return a warning.
 * The user can still proceed but the warning is logged for audit trail.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.review',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const { data: draft } = await supabase
      .from('salary_runs')
      .select('id, status, calculation_params')
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .maybeSingle()

    if (!draft) return notDraftResponse()

    const { data: runEmployees } = await supabase
      .from('salary_run_employees')
      .select('employee_id, calculation_breakdown, employee:employees(first_name, last_name, f_skatt_status)')
      .eq('salary_run_id', id)
      .eq('company_id', companyId)

    const roster = (runEmployees || []) as unknown as Array<{
      employee_id: string
      calculation_breakdown: unknown
      employee: { first_name: string; last_name: string; f_skatt_status: string } | null
    }>

    const calculationState = runCalculationState(draft, roster)
    if (calculationState === 'not_calculated') {
      return errorResponseFromCode('SALARY_RUN_NOT_CALCULATED', log, {
        requestId,
        messageSv: 'Lönekörningen är inte beräknad: beräkna den innan den skickas till granskning.',
        messageEn: 'The run has not been calculated: calculate it before sending it for review.',
      })
    }
    if (calculationState === 'stale') {
      const names = rosterRowsWithoutCalculation(roster).map(
        (sre) => `${sre.employee?.first_name ?? ''} ${sre.employee?.last_name ?? ''}`.trim() || sre.employee_id,
      )
      return errorResponseFromCode('SALARY_RUN_NOT_CALCULATED', log, {
        requestId,
        messageSv: `Beräkningen är inte aktuell för ${names.join(', ')}: beräkna om lönekörningen innan den skickas till granskning.`,
        messageEn: `The calculation is out of date for ${names.join(', ')}: recalculate the run before sending it for review.`,
        details: { employees: names },
      })
    }

    // Check for F-skatt verification warnings
    const warnings: string[] = []
    for (const sre of roster) {
      const emp = sre.employee
      if (emp?.f_skatt_status === 'not_verified') {
        warnings.push(
          `${emp.first_name} ${emp.last_name}: F-skatt ej verifierad: 30% skatteavdrag och fulla avgifter tillämpas (f-skatt.md)`
        )
      }
    }

    // Optimistic lock on status='draft': a concurrent step that advanced the
    // run since the read above fails this write instead of repeating it.
    const { data: run, error } = await supabase
      .from('salary_runs')
      .update({ status: 'review' })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .select()
      .single()

    if (error || !run) return notDraftResponse()

    return NextResponse.json({
      data: run,
      warnings: warnings.length > 0 ? warnings : undefined,
    })
  },
  { requireWrite: true },
)
