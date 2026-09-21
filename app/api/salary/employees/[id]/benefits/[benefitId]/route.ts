import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeBenefitSchema } from '@/lib/api/schemas'
import { deleteEmployeeBenefit, updateEmployeeBenefit } from '@/lib/salary/employee-benefits'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/**
 * Render a shared-module failure as this route's legacy `{ error }` envelope.
 *
 * `details.field` marks a message the module authored for the user (the
 * merged validity period, a check_violation on the update, annual_market_value
 * on a non-bike row) and is shown as is. Every other failure carries the raw
 * Postgres message and SQLSTATE; rebuilt as an Error with a `code`, the shape
 * PostgrestError has, it sends getUserErrorMessage down the same path the
 * inline queries used to take, so the text is unchanged.
 */
function failureResponse(failure: { code: string; details?: Record<string, unknown> }) {
  if (failure.code === 'EMPLOYEE_NOT_FOUND') {
    return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
  }
  if (failure.code === 'NOT_FOUND') {
    return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
  }
  const details = failure.details ?? {}
  if (failure.code === 'VALIDATION_ERROR' && typeof details.field === 'string') {
    return NextResponse.json({ error: String(details.message) }, { status: 400 })
  }
  const pgError = Object.assign(
    new Error(typeof details.message === 'string' ? details.message : ''),
    { code: typeof details.pg_code === 'string' ? details.pg_code : undefined },
  )
  const status = failure.code === 'VALIDATION_ERROR' ? 400 : 500
  return NextResponse.json({ error: getUserErrorMessage(pgError) }, { status })
}

export const PATCH = withRouteContext<{ params: Promise<{ id: string; benefitId: string }> }>(
  'salary.employees.benefits.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id, benefitId } = await params

    const validation = await validateBody(request, UpdateEmployeeBenefitSchema)
    if (!validation.success) return validation.response

    const result = await updateEmployeeBenefit(supabase, {
      companyId,
      employeeId: id,
      benefitId,
      patch: validation.data,
    })
    if (!result.ok) return failureResponse(result)

    // No dry-run on this door: the outcome is always the updated row.
    const outcome = result.data
    return NextResponse.json({ data: outcome.committed ? outcome.row : outcome.preview })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; benefitId: string }> }>(
  'salary.employees.benefits.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id, benefitId } = await params

    const result = await deleteEmployeeBenefit(supabase, { companyId, employeeId: id, benefitId })
    if (!result.ok) return failureResponse(result)

    // No dry-run on this door: the outcome is always committed. A benefit
    // that a payslip line derives from is kept and switched off
    // (deleted=false, deactivated=true) so the line keeps its provenance and
    // the next recalculation of a draft run drops it (#2695); the panel
    // tells the user to recalculate. Neither flag set means no row matched.
    const outcome = result.data
    const deleted = outcome.committed && outcome.deleted
    const deactivated = outcome.committed && outcome.deactivated === true
    if (!deleted && !deactivated) {
      return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
    }
    return NextResponse.json({ data: { id: benefitId, deleted, deactivated } })
  },
  { requireWrite: true },
)
