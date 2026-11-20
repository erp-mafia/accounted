import type { NextResponse } from 'next/server'
import { sessionFailureResponse } from '@/lib/operations/session'
import type { ServiceFailure } from './result'

/** Map a service failure onto the canonical error envelope (sessionFailureResponse). */
export function serviceFailureResponse(
  failure: ServiceFailure,
  log: Parameters<typeof sessionFailureResponse>[1],
  requestId?: string,
): NextResponse {
  return sessionFailureResponse(
    'dbError' in failure ? { ok: false, code: 'INTERNAL_ERROR', error: failure.dbError ?? new Error('unknown database error') } : failure,
    log,
    requestId,
  )
}
