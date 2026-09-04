import type { NextResponse } from 'next/server'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { ServiceFailure } from './result'

type MinimalLog = Parameters<typeof errorResponseFromCode>[1]

/** Map a service failure onto the canonical error envelope. */
export function serviceFailureResponse(
  failure: ServiceFailure,
  log: MinimalLog,
  requestId?: string,
): NextResponse {
  if ('dbError' in failure) return errorResponse(failure.dbError, log, { requestId })
  return errorResponseFromCode(failure.code, log, { requestId, details: failure.details })
}
