import { createLogger } from '@/lib/logger'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'
import {
  UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
  maskCustomerPersonalNumber,
} from '@/lib/customers/mask-personal-number'

const log = createLogger('customers/protect-personal-number')

// Re-exported so server callers can keep importing the placeholder from the
// module that produces it. The constant itself lives in mask-personal-number.ts
// alongside the regex that recognizes it, which the client form and the Zod
// schemas also need and which must not pull in this module's crypto imports.
export { UNDECRYPTABLE_PERSONAL_NUMBER_MASK }

export function encryptCustomerPersonalNumber(value: string | null | undefined): string | null {
  return value ? encryptPersonnummer(value) : null
}

/**
 * Decrypt-and-mask a stored customers.personal_number for display.
 *
 * Never throws: every customer read surface (list, detail, export) maps rows
 * through this, so a single row with an undecryptable value must not 500 the
 * whole endpoint. On decrypt failure it logs at error level (the value itself
 * is never logged) and returns UNDECRYPTABLE_PERSONAL_NUMBER_MASK.
 */
export function maskStoredCustomerPersonalNumber(value: string | null | undefined): string | null {
  if (!value) return null
  if (/^(\d{6}|\d{8})[-+]?\d{4}$/.test(value)) {
    return maskCustomerPersonalNumber(value)
  }
  try {
    return maskCustomerPersonalNumber(decryptPersonnummer(value))
  } catch (err) {
    log.error('customer personal_number decrypt failed; returning placeholder mask', {
      reason: err instanceof Error ? err.message : String(err),
    })
    return UNDECRYPTABLE_PERSONAL_NUMBER_MASK
  }
}

/**
 * Decrypt a stored customers.personal_number back to plaintext.
 *
 * The deliberate drill-in behind the mask, and the ONLY function that returns
 * the full identifier. It mirrors the employee convention (v1 employee list
 * masks, v1 employee detail returns all 12 digits): a value the user typed in
 * has to be readable back, or the field is write-only and unverifiable.
 *
 * Callers own the access decision and the audit entry; this function only
 * decrypts. Returns null when there is nothing stored, and throws when the
 * value cannot be decrypted so the caller can answer with a specific error
 * rather than a plausible-looking wrong number.
 */
export function revealStoredCustomerPersonalNumber(value: string | null | undefined): string | null {
  if (!value) return null
  // A legacy plaintext row (written before the 2026-07-15 encryption change,
  // or on a self-hosted DB) is already the answer.
  if (/^(\d{6}|\d{8})[-+]?\d{4}$/.test(value)) return value
  return decryptPersonnummer(value)
}

export function maskCustomerRow<T extends { personal_number?: string | null }>(row: T): T {
  return {
    ...row,
    personal_number: maskStoredCustomerPersonalNumber(row.personal_number),
  }
}

/**
 * Mask the personnummer on a row that EMBEDS a customer, e.g. the
 * `customer:customers(*)` join every invoice endpoint selects.
 *
 * Those embeds carry the raw ciphertext out to the browser. Nothing renders
 * it, so it produced no visible bug the way the customer list did, but it is
 * the same value crossing the same wire for no reason. Masking at the response
 * boundary rather than narrowing the projection keeps every other customer
 * field available to the server-side consumers (PDF rendering, invoice email,
 * ROT/RUT validation) that legitimately read the whole row.
 *
 * Null-safe on both the row and the embed: PostgREST returns `customer: null`
 * for an invoice whose customer was removed.
 */
export function maskEmbeddedCustomer<T>(row: T): T {
  if (!row || typeof row !== 'object') return row
  const embedded = (row as { customer?: { personal_number?: string | null } | null }).customer
  if (!embedded || typeof embedded !== 'object') return row
  return { ...row, customer: maskCustomerRow(embedded) }
}
