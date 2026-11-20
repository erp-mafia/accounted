/**
 * A customer command's refusal (lib/customers/customer-commands.ts) as the
 * dashboard response: a write failure carries the database reason, the
 * country rule carries its own Swedish and English text, and every other code
 * is its structured error (sessionFailureResponse).
 */
import type { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import { sessionFailureResponse } from '@/lib/operations/session'
import type { OperationOutcome } from '@/lib/operations/types'

const CUSTOMER_WRITE_FAILURES = ['CUSTOMER_CREATE_FAILED', 'CUSTOMER_UPDATE_FAILED'] as const

export function customerFailureResponse(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  log: Logger,
  requestId: string | undefined,
): NextResponse {
  if (outcome.code === 'CUSTOMER_COUNTRY_MISMATCH') {
    const { message_sv: messageSv, message_en: messageEn, ...details } = outcome.details ?? {}
    return errorResponseFromCode(outcome.code, log, {
      requestId,
      messageSv: messageSv as string | undefined,
      messageEn: messageEn as string | undefined,
      details,
    })
  }
  // This door has always answered the registry message, not the command's
  // messageSv (the empty-update refusal's own sentence reaches v1 and MCP
  // only): kept as it was.
  return sessionFailureResponse({ ...outcome, messageSv: undefined, messageEn: undefined }, log, requestId, {
    writeFailureCodes: CUSTOMER_WRITE_FAILURES,
  })
}
