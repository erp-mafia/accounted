/**
 * The personnummer typed before BankID when the person has none on file:
 * accepted in the forms people write (YYMMDD-NNNN, YYYYMMDDNNNN, with or
 * without the hyphen) and sent to the bank as the 12 digits it expects, the
 * same rule the server applies (lib/auth/bankid-signer.ts
 * normalizeSignerPersonalNumber). Never logged, never stored here.
 */

import { expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'

/** The 12-digit form the bank expects, or null when the input is not a valid personnummer. */
export function normalizePersonalNumber(raw: string, now: Date = new Date()): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const full = expandPersonnummerTo12(trimmed, now)
  return full && validatePersonnummer(full).valid ? full : null
}

/** Whether the field has anything in it that is not yet a valid number (shown as a hint, not an error, while typing). */
export function personalNumberIncomplete(raw: string, now: Date = new Date()): boolean {
  return raw.trim().length > 0 && normalizePersonalNumber(raw, now) === null
}
