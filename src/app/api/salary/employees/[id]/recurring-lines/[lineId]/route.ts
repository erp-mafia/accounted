import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeRecurringLineSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  deleteEmployeeRecurringLine,
  updateEmployeeRecurringLine,
  type RecurringLineFailure,
} from '@/lib/salary/employee-recurring-lines'

ensureInitialized()

/**
 * Map a module failure to the dashboard's `{ error: string }` envelope. A
 * VALIDATION_ERROR carries field issues in user copy (amount sign, merged
 * validity period: the same strings the schema uses); anything else renders
 * the raw database error through getErrorMessage, as the route always did.
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

export const PATCH = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.employees.recurring_lines.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id, lineId } = await params

    const validation = await validateBody(request, UpdateEmployeeRecurringLineSchema)
    if (!validation.success) return validation.response

    const result = await updateEmployeeRecurringLine(supabase, {
      companyId,
      employeeId: id,
      lineId,
      patch: validation.data,
    })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.employees.recurring_lines.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id, lineId } = await params

    // Delete-first; a line a run has already derived from is deactivated
    // instead (the module documents the FK mechanics).
    const result = await deleteEmployeeRecurringLine(supabase, {
      companyId,
      employeeId: id,
      lineId,
    })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)
