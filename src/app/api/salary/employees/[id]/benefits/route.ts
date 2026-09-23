import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateEmployeeBenefitSchema } from '@/lib/api/schemas'
import { createEmployeeBenefit, listEmployeeBenefits } from '@/lib/salary/employee-benefits'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/**
 * Render a shared-module failure as this route's legacy `{ error }` envelope.
 *
 * `details.field` marks a message the module authored for the user (validity
 * period, annual_market_value on a non-bike row) and is shown as is. Every
 * other failure carries the raw Postgres message and SQLSTATE; rebuilt as an
 * Error with a `code`, the shape PostgrestError has, it sends
 * getUserErrorMessage down the same path (Postgres code map, then the
 * fallbacks) the inline queries used to take, so the text is unchanged.
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
  // A CHECK violation is bad input, not a server fault. The create schema
  // mirrors every CHECK on the table (benefit_type, monthly_value >= 0,
  // valid_to >= valid_from), so this is only the backstop for non-schema
  // callers; answering 500 told the user to retry an insert that can never
  // succeed.
  const status = failure.code === 'VALIDATION_ERROR' ? 400 : 500
  return NextResponse.json({ error: getUserErrorMessage(pgError) }, { status })
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.benefits.list',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Active rows only: this is the register the panel lets the user add to
    // and remove from. A removed benefit that a payslip line derives from is
    // kept as is_active=false for provenance (#2695), and the engine (step
    // 8d) reads active rows only, so listing inactive rows here would show a
    // "removed" benefit as live. History stays reachable on v1 (?active=false)
    // and in the archive export.
    const result = await listEmployeeBenefits(supabase, { companyId, employeeId: id, active: true })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.benefits.create',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, CreateEmployeeBenefitSchema)
    if (!validation.success) return validation.response

    const result = await createEmployeeBenefit(supabase, {
      companyId,
      employeeId: id,
      userId: user.id,
      input: validation.data,
    })
    if (!result.ok) return failureResponse(result)

    // No dry-run on this door: the outcome is always the inserted row.
    const outcome = result.data
    return NextResponse.json(
      { data: outcome.committed ? outcome.row : outcome.preview },
      { status: 201 },
    )
  },
  { requireWrite: true },
)
