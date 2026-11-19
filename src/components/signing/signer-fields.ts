/**
 * The checks a signer row makes before anything is sent, shared by Begär
 * signering (RequestSignatureDialog) and the board's BankID signing of the
 * årsredovisning. The server checks the same again (lib/signing/requests.ts
 * checkSigners): these only say it sooner.
 */
import { expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'

export const SIGNER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A typed personnummer the server would take: 10 or 12 digits with a valid check digit. */
export function personalNumberValid(value: string): boolean {
  const full = expandPersonnummerTo12(value)
  return full !== null && validatePersonnummer(full).valid
}
