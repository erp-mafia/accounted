import type { NextResponse } from 'next/server'
import { EntityTypeMigrationError } from '@/lib/company/entity-type-migration'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

type Log = Parameters<typeof errorResponse>[1]

/** Map a migration error to its catalogue code; anything else to errorResponse. */
export function entityTypeMigrationErrorResponse(err: unknown, log: Log, requestId?: string): NextResponse {
  if (err instanceof EntityTypeMigrationError) {
    return errorResponseFromCode(err.code, log, { requestId, details: err.details })
  }
  return errorResponse(err, log, { requestId })
}
