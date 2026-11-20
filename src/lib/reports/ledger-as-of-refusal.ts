import type { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { LedgerAsOfDate } from './ledger-as-of'

/** A dashboard route's answer to a date parseLedgerAsOfDate refused: 400 in the check's own words. */
export function ledgerAsOfRefusal(
  refused: Extract<LedgerAsOfDate, { ok: false }>,
  log: Parameters<typeof errorResponseFromCode>[1],
  requestId: string,
): NextResponse {
  return errorResponseFromCode('VALIDATION_ERROR', log, {
    requestId,
    messageSv: refused.messageSv,
    messageEn: refused.message,
    details: { field: 'as_of_date' },
  })
}
