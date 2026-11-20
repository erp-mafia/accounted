import { NextResponse } from 'next/server'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Render a shared-module failure as the benefit routes' legacy `{ error }`
 * envelope (the collection route and the per-benefit route answer alike).
 *
 * `details.field` marks a message the module authored for the user (validity
 * period, a check_violation on the update, annual_market_value on a non-bike
 * row) and is shown as is. Every other failure carries the raw Postgres
 * message and SQLSTATE; rebuilt as an Error with a `code`, the shape
 * PostgrestError has, it sends getUserErrorMessage down the same path
 * (Postgres code map, then the fallbacks) the inline queries used to take, so
 * the text is unchanged.
 */
export function failureResponse(failure: { code: string; details?: Record<string, unknown> }) {
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
