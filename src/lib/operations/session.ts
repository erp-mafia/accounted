/**
 * Dashboard (session-cookie) door for an operation's failure: the same code,
 * details and Swedish message the v1 and MCP doors answer, in the
 * dashboard's `{ error: { code, message, ... } }` envelope. Success shapes
 * stay with each route, because the dashboard's response bodies predate the
 * operation registry and the UI reads them as they are.
 */
import type { NextResponse } from 'next/server'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import type { OperationOutcome } from './types'

export function sessionFailureResponse(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  log: Logger,
  requestId: string,
): NextResponse {
  if (outcome.error) return errorResponse(outcome.error, log, { requestId })
  return errorResponseFromCode(outcome.code, log, {
    requestId,
    details: outcome.details,
    ...(outcome.messageSv ? { messageSv: outcome.messageSv } : {}),
  })
}
