/**
 * Display forms of customers.personal_number, and the one regex that
 * recognizes them.
 *
 * This module is deliberately free of any crypto import so it can be shared by
 * the client form, the Zod schemas and the server read paths. The decrypting
 * half lives in lib/customers/protect-personal-number.ts, which is server-only.
 */

import { looksLikeSwedishPersonalNumber } from '@/lib/customers/personal-number-shape'

/**
 * Placeholder used when a stored personal_number cannot be decrypted
 * (corrupted ciphertext, a value written under a different
 * PERSONNUMMER_ENCRYPTION_KEY, or pre-encryption garbage on a self-hosted DB).
 *
 * Shape rationale: it must be recognizably a mask (never mistakable for a real
 * suffix, so no fabricated digits) and it must NOT be null. Returning null
 * would render as "no personnummer", and worse: a client that reads the
 * customer and PATCHes the whole object back would send personal_number: null,
 * which the update route treats as "clear the column", destroying the stored
 * ciphertext.
 */
export const UNDECRYPTABLE_PERSONAL_NUMBER_MASK = '********-????'

/**
 * Every masked display form the read paths can emit: '********-1234' for a
 * value that decrypted, '********-????' for one that did not.
 *
 * Both mean the same thing to a write path: the client is echoing back what it
 * read, so leave the stored value alone. Keeping one regex here rather than a
 * copy in each of the three consumers (UpdateCustomerSchema, the PATCH route,
 * CustomerForm) is what makes that true. The earlier copies covered the
 * '-1234' form only, so an undecryptable row failed validation in all three
 * places at once and its customer could not be edited at all: not the
 * personnummer, not the name, not the address.
 *
 * The asterisk prefix can never collide with a valid personnummer, so widening
 * the suffix does not loosen anything a real value relies on.
 */
export const PERSONAL_NUMBER_MASK_RE = /^\*{8}-(?:\d{4}|\?{4})$/

/** True when `value` is a masked display form rather than a real personnummer. */
export function isMaskedPersonalNumber(value: unknown): boolean {
  return typeof value === 'string' && PERSONAL_NUMBER_MASK_RE.test(value)
}

/**
 * What an edit surface may submit for personal_number: a plaintext personnummer
 * in any of the four accepted forms, or a mask meaning "unchanged".
 *
 * Shared by UpdateCustomerSchema and the CustomerForm resolver so the client
 * and the server cannot drift on which values are submittable. Create paths use
 * the plaintext half alone.
 */
export const PERSONAL_NUMBER_INPUT_RE = /^(?:(?:\d{6}|\d{8})[-+]?\d{4}|\*{8}-(?:\d{4}|\?{4}))$/

/**
 * The plaintext half alone: the four accepted written forms of a personnummer
 * (YYMMDD-XXXX, YYMMDD+XXXX, YYYYMMDD-XXXX, or the 10/12 digits). What a create
 * path accepts.
 */
export const PERSONAL_NUMBER_PLAINTEXT_RE = /^(?:\d{6}|\d{8})[-+]?\d{4}$/

/**
 * Display a personal identity number without exposing birth date or full ID.
 *
 * Already-masked input is returned unchanged: the API masks on read, so a
 * client that masks again on render must not turn '********-1234' into
 * something else, nor '********-????' into null (which would render as "no
 * personnummer" for a row that has one).
 */
export function maskCustomerPersonalNumber(value: string | null | undefined): string | null {
  if (!value) return null
  if (isMaskedPersonalNumber(value)) return value
  const last4 = value.replace(/\D/g, '').slice(-4)
  return last4.length === 4 ? `********-${last4}` : null
}

/**
 * The identifier a customer LIST may show for a row, never a raw personnummer.
 *
 * Business rows show org_number (Bolagsverket-public). Individual rows show
 * the masked personal_number; a legacy individual row that still carries its
 * personnummer in org_number (written before the write paths started moving
 * it, see lib/customers/personal-number-shape.ts) shows that value masked the
 * same way instead of raw. Callers pass rows whose personal_number is already
 * the API's masked form or a plaintext value; ciphertext must be masked
 * server-side first (maskStoredCustomerPersonalNumber).
 */
export function customerListIdentifier(row: {
  customer_type?: string | null
  org_number?: string | null
  personal_number?: string | null
}): string {
  if (row.customer_type !== 'individual') {
    return row.org_number || row.personal_number || ''
  }
  if (row.personal_number) return maskCustomerPersonalNumber(row.personal_number) ?? ''
  const orgNumber = row.org_number || ''
  if (orgNumber && looksLikeSwedishPersonalNumber(orgNumber)) {
    return maskCustomerPersonalNumber(orgNumber) ?? ''
  }
  return orgNumber
}
