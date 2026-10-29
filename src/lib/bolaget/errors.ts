/**
 * One translation from what the Bolaget services and the database refuse to
 * an operation failure: the code from lib/errors/structured-errors.ts and,
 * where the refusal names the shares or the entry, its Swedish sentence.
 */
import type { OperationOutcome } from '@/lib/operations/types'
import { ShareRegisterError } from './register-state'
import { PartyRefError } from './people'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** Codes the database raises as `CODE: text` (20261029210000_bolaget_registers.sql). */
const DB_CODES = [
  'SHARE_REGISTER_RANGE_TAKEN',
  'SHARE_REGISTER_NOT_HELD',
  'SHARE_REGISTER_RATIO_MISALIGNED',
  'SHARE_REGISTER_APPEND_ONLY',
  'SHARE_REGISTER_AVSTAMNINGSBOLAG',
  'SHARE_REGISTER_CORRECTION_INVALID',
  'COMPANY_ROLE_APPEND_ONLY',
  'COMPANY_ROLE_ALREADY_ENDED',
  'BENEFICIAL_OWNER_APPEND_ONLY',
] as const

export function bolagetFailure(error: unknown): Failure {
  if (error instanceof ShareRegisterError) {
    return {
      ok: false,
      code: error.code,
      messageSv: error.message,
      ...(error.eventNumber !== null ? { details: { event_number: error.eventNumber } } : {}),
    }
  }
  if (error instanceof PartyRefError) return { ok: false, code: error.code, messageSv: error.message }
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : ''
  const code = DB_CODES.find((c) => message.includes(c))
  if (code) return { ok: false, code }
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}
