import type { NextResponse } from 'next/server'
import { BrfError } from '@/lib/company/brf-tax-profile'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

type Log = Parameters<typeof errorResponse>[1]

/** Map a BRF fact error to its catalogue code; anything else to errorResponse. */
export function brfErrorResponse(err: unknown, log: Log, requestId?: string): NextResponse {
  if (err instanceof BrfError) {
    return errorResponseFromCode(err.code, log, { requestId })
  }
  return errorResponse(err, log, { requestId })
}
