import type { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { SIEJobValidationError } from './sie-jobs'

type RouteLogger = Parameters<typeof errorResponseFromCode>[1]

/**
 * The 400 for a SIEJobValidationError, carrying the validator's own sentence.
 *
 * validateSIEJobInput names exactly what refused the file ("SIE-verifikation
 * LESSLIE2 (2025-01-02) ligger utanför räkenskapsåret."), but the generic
 * VALIDATION_ERROR code it throws under maps to the registry's "Förfrågan
 * innehåller ogiltiga uppgifter." in errorResponse, and the migration
 * wizard's route wrapped it as SIE_IMPORT_UNEXPECTED (500) on top. Both
 * surfaces then showed a sentence that named nothing; the reason lived only
 * in details.reason and the logs. A code with its own registry entry
 * (SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS) keeps that bilingual text and its
 * details: the entry already is the specific reason.
 */
export function sieJobValidationResponse(
  error: SIEJobValidationError,
  log: RouteLogger,
  requestId?: string,
): NextResponse {
  const specificEntry = error.code !== 'VALIDATION_ERROR'
  return errorResponseFromCode(error.code, log, {
    requestId,
    status: 400,
    reason: error.message,
    ...(error.details ? { details: error.details } : {}),
    // The sv/en pair is overridden together (the context's contract). The
    // validator writes Swedish only, and that sentence beats "Validation
    // error." for an English client too: it names the voucher.
    ...(specificEntry ? {} : { messageSv: error.message, messageEn: error.message }),
  })
}
