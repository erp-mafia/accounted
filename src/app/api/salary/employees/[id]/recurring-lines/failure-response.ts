import { NextResponse } from 'next/server'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { RecurringLineFailure } from '@/lib/salary/employee-recurring-lines'

/**
 * Map a module failure to the dashboard's `{ error: string }` envelope (the
 * collection route and the per-line route answer alike). A VALIDATION_ERROR
 * carries either field issues in user copy (the module's own checks: amount
 * sign, merged validity period, the same strings the schema uses) or the raw
 * check_violation from the write; that one, and anything else, renders
 * through getErrorMessage exactly as the routes did before the module.
 */
export function failureResponse(failure: RecurringLineFailure): NextResponse {
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
