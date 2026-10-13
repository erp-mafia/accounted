/**
 * A customer command's refusal (lib/customers/customer-commands.ts) as the
 * dashboard response: a write failure carries the database reason, the
 * country rule carries its own Swedish and English text, and every other code
 * is its structured error.
 */
import type { NextResponse } from 'next/server'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import type { OperationOutcome } from '@/lib/operations/types'

export function customerFailureResponse(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  log: Logger,
  requestId: string | undefined,
): NextResponse {
  if (outcome.code === 'CUSTOMER_CREATE_FAILED' || outcome.code === 'CUSTOMER_UPDATE_FAILED') {
    return errorResponseFromCode(outcome.code, log, {
      requestId,
      details: { reason: getUserErrorMessage(outcome.error) },
    })
  }
  if (outcome.code === 'CUSTOMER_COUNTRY_MISMATCH') {
    const { message_sv: messageSv, message_en: messageEn, ...details } = outcome.details ?? {}
    return errorResponseFromCode(outcome.code, log, {
      requestId,
      messageSv: messageSv as string | undefined,
      messageEn: messageEn as string | undefined,
      details,
    })
  }
  return errorResponseFromCode(outcome.code, log, { requestId, details: outcome.details })
}
