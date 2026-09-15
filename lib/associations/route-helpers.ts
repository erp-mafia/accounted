import type { NextResponse } from 'next/server'
import { AssociationRegisterError } from '@/lib/associations/errors'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

type Log = Parameters<typeof errorResponse>[1]

/** Map a register error to its catalogue code; anything else to errorResponse. */
export function associationErrorResponse(err: unknown, log: Log, requestId?: string): NextResponse {
  if (err instanceof AssociationRegisterError) {
    return errorResponseFromCode(err.code, log, { requestId })
  }
  return errorResponse(err, log, { requestId })
}
