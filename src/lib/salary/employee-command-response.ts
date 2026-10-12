/**
 * The dashboard employee routes' answer to a refused employee command
 * (lib/salary/employee-commands.ts, lib/salary/employee-soft-delete.ts): the
 * flat `{ error }` body the salary pages read, in Swedish. v1 and MCP phrase
 * the same codes through their own envelopes.
 */

import { NextResponse } from 'next/server'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export function employeeCommandErrorResponse(result: {
  code: string
  details?: Record<string, unknown>
  cause?: unknown
}): NextResponse {
  switch (result.code) {
    case 'VALIDATION_ERROR':
      return NextResponse.json(
        { error: (result.details?.message as string | undefined) ?? 'Ogiltiga uppgifter för den anställda' },
        { status: 400 },
      )
    case 'EMPLOYEE_DUPLICATE_PERSONNUMMER':
      return NextResponse.json({ error: 'En anställd med detta personnummer finns redan' }, { status: 409 })
    case 'EMPLOYEE_NOT_FOUND':
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    default:
      return NextResponse.json(
        { error: result.cause ? getUserErrorMessage(result.cause) : 'Något gick fel. Försök igen.' },
        { status: 500 },
      )
  }
}
