import type { NextResponse } from 'next/server'
import { BrfError } from '@/lib/company/brf-tax-profile'
import { BrfRegisterError } from '@/lib/brf/errors'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

type Log = Parameters<typeof errorResponse>[1]

/**
 * Map a BRF register or fact error to its catalogue code; anything else to
 * errorResponse. Superset of lib/company/brf-route-helpers so the register
 * routes can call requireBrfForm from the tax-profile module.
 */
export function brfRegisterErrorResponse(err: unknown, log: Log, requestId?: string): NextResponse {
  if (err instanceof BrfRegisterError || err instanceof BrfError) {
    return errorResponseFromCode(err.code, log, { requestId })
  }
  return errorResponse(err, log, { requestId })
}
