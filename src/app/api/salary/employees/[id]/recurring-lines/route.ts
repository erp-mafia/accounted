import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateEmployeeRecurringLineSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  createEmployeeRecurringLine,
  listEmployeeRecurringLines,
  type RecurringLineFailure,
} from '@/lib/salary/employee-recurring-lines'

ensureInitialized()

/**
 * Map a module failure to the dashboard's `{ error: string }` envelope. A
 * VALIDATION_ERROR carries either field issues (the module's own checks,
 * already in user copy) or the raw check_violation from the insert, which
 * getErrorMessage renders exactly as the route did before the module.
 */
function failureResponse(failure: RecurringLineFailure): NextResponse {
  switch (failure.code) {
    case 'EMPLOYEE_NOT_FOUND':
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    case 'NOT_FOUND':
      return NextResponse.json({ error: 'Raden hittades inte' }, { status: 404 })
    case 'VALIDATION_ERROR': {
      const issues = failure.details?.issues as Array<{ message: string }> | undefined
      const message = issues?.[0]?.message ?? getUserErrorMessage(failure.cause)
      return NextResponse.json({ error: message }, { status: 400 })
    }
    default:
      return NextResponse.json({ error: getUserErrorMessage(failure.cause) }, { status: 500 })
  }
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.recurring_lines.list',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const result = await listEmployeeRecurringLines(supabase, { companyId, employeeId: id })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.recurring_lines.create',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, CreateEmployeeRecurringLineSchema)
    if (!validation.success) return validation.response

    const result = await createEmployeeRecurringLine(supabase, {
      companyId,
      employeeId: id,
      userId: user.id,
      input: validation.data,
    })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data }, { status: 201 })
  },
  { requireWrite: true },
)
