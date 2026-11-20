/**
 * The meeting services' failures: a typed error the services throw for what
 * they refuse themselves, and one translation of those and of the database's
 * refusals (20261030010000_corporate_meetings.sql) to an operation failure.
 */
import type { OperationOutcome } from '@/lib/operations/types'
import { bolagetFailure } from '../errors'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export type MeetingErrorCode =
  | 'CORPORATE_MEETING_NOT_FOUND'
  | 'CORPORATE_DECISION_NOT_FOUND'
  | 'CORPORATE_MEETING_LOCKED'
  | 'CORPORATE_MEETING_NOT_HELD'
  | 'CORPORATE_MEETING_NOT_DRAFT'
  | 'CORPORATE_MEETING_ALREADY_HELD'
  | 'CORPORATE_MEETING_IN_FUTURE'
  | 'CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED'
  | 'CORPORATE_MEETING_FISCAL_PERIOD_NOT_FOUND'
  | 'CORPORATE_DECISION_PAYLOAD_INVALID'
  | 'CORPORATE_MEETING_SIGNING_PENDING'
  | 'CORPORATE_MEETING_SIGNERS_MISSING'
  | 'CORPORATE_MEETING_FILE_INVALID'

export class MeetingError extends Error {
  constructor(
    readonly code: MeetingErrorCode,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code)
    this.name = 'MeetingError'
  }
}

/** Codes the database raises as `CODE: text`. */
const DB_CODES: readonly MeetingErrorCode[] = ['CORPORATE_MEETING_LOCKED', 'CORPORATE_MEETING_NOT_HELD', 'CORPORATE_MEETING_NOT_FOUND']

export function meetingFailure(error: unknown): Failure {
  if (error instanceof MeetingError) {
    return {
      ok: false,
      code: error.code,
      ...(error.message !== error.code ? { messageSv: error.message } : {}),
      ...(error.details ? { details: error.details } : {}),
    }
  }
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : ''
  const code = DB_CODES.find((c) => message.includes(c))
  if (code) return { ok: false, code }
  return bolagetFailure(error)
}
