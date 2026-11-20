/**
 * Dashboard (session-cookie) door for an operation's failure: the same code,
 * details and Swedish message the v1 and MCP doors answer, in the
 * dashboard's `{ error: { code, message, ... } }` envelope. Success shapes
 * stay with each route, because the dashboard's response bodies predate the
 * operation registry and the UI reads them as they are.
 *
 * The one responder for every dashboard refusal: the customer, article and
 * sales-order doors answer through it too (their own rules are the options
 * below and the one code each that keeps its own envelope).
 */
import type { NextResponse } from 'next/server'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { OperationOutcome } from './types'

type FailureLog = Parameters<typeof errorResponse>[1]

export interface SessionFailureOptions {
  /**
   * Codes whose `error` is a failed database write: the answer is the code's
   * own envelope with the database reason, in Swedish, under details.reason,
   * never the database error itself (a customer or article write).
   */
  writeFailureCodes?: readonly string[]
}

export function sessionFailureResponse(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  log: FailureLog,
  requestId: string | undefined,
  options: SessionFailureOptions = {},
): NextResponse {
  if (options.writeFailureCodes?.includes(outcome.code)) {
    return errorResponseFromCode(outcome.code, log, {
      requestId,
      details: { reason: getErrorMessage(outcome.error) },
    })
  }
  if (outcome.error) return errorResponse(outcome.error, log, { requestId, details: outcome.details })
  return errorResponseFromCode(outcome.code, log, {
    requestId,
    details: outcome.details,
    ...(outcome.messageSv ? { messageSv: outcome.messageSv } : {}),
    ...(outcome.messageSv && outcome.messageEn ? { messageEn: outcome.messageEn } : {}),
    ...(outcome.remediation ? { remediation: outcome.remediation } : {}),
  })
}
