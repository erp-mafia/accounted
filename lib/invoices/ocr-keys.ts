/**
 * The reference keys one customer invoice can legitimately be paid under.
 *
 * WHY. What the customer types into the bank is what we PRINTED on the invoice:
 * `generateOcrReference(invoice_number)`, i.e. the invoice number's digits plus
 * a Luhn check digit (lib/invoices/pdf-template.tsx, and PaymentID on the
 * Peppol payload in lib/invoices/peppol-bis-billing.ts). The matcher, however,
 * compared the bank reference with the bare invoice number, so a payment made
 * with the printed OCR never auto-matched (issue #2555). The two values were
 * derived independently, so they drifted.
 *
 * This module is the one place that answers "which references identify this
 * invoice", and it answers it by calling the same generator the PDF calls.
 * Print and match can no longer disagree.
 *
 * Equality is over digits only: banks emit references with varying separators
 * ("2026-0042", "2026 0042", "2026/0042") and the OCR spec is a digit string.
 */

import { generateOcrReference, validateOcrReference } from '@/lib/bankgiro/luhn'
import { normalizeOcrReference } from './duplicate-payment-guard'

/**
 * `invoice_number`: the invoice number's bare digits, which is what the
 * matcher has always compared and what customers who type the number by hand
 * send. `ocr`: those digits plus the Luhn check digit, which is what the
 * invoice actually prints.
 */
export type InvoiceReferenceForm = 'invoice_number' | 'ocr'

export interface InvoiceReferenceKey {
  /** Digits only, ready for equality against a normalised bank reference. */
  key: string
  form: InvoiceReferenceForm
}

/**
 * Below this, a key is too short to hunt for inside free bank text: a 3-digit
 * run turns up in dates, amounts and card suffixes. Exact-reference equality
 * has no such floor, because there the whole field is the reference.
 */
export const MIN_REFERENCE_KEY_DIGITS = 4

/**
 * Every reference a payer could quote for this invoice, digit-normalised.
 * Empty when the invoice number carries no digits at all (nothing to match on).
 */
export function invoiceReferenceKeys(
  invoiceNumber: string | null | undefined,
): InvoiceReferenceKey[] {
  const raw = invoiceNumber ?? ''
  const bare = normalizeOcrReference(raw)
  if (!bare) return []

  const keys: InvoiceReferenceKey[] = [{ key: bare, form: 'invoice_number' }]

  // generateOcrReference returns its input unchanged for out-of-range lengths,
  // in which case the normalised result is just `bare` again and adds nothing.
  const ocr = normalizeOcrReference(generateOcrReference(raw))
  if (ocr && ocr !== bare) keys.push({ key: ocr, form: 'ocr' })

  return keys
}

/**
 * True when an already digit-normalised bank reference is one of the invoice's
 * keys. Takes the normalised form so a caller that compares one reference
 * against many invoices normalises it once.
 */
export function matchesNormalizedReference(
  invoiceNumber: string | null | undefined,
  normalizedReference: string,
): boolean {
  if (!normalizedReference) return false
  return invoiceReferenceKeys(invoiceNumber).some((k) => k.key === normalizedReference)
}

/**
 * The subset of keys distinctive enough to be trusted on their own: long
 * enough not to be a coincidence, and, for the OCR form, still carrying a
 * valid check digit. Use these when the key is searched for inside free text
 * (description, merchant name) or compared against a reference field whose
 * provenance is unknown; exact equality against a dedicated reference field
 * needs no such floor.
 */
export function distinctiveReferenceKeys(
  invoiceNumber: string | null | undefined,
): string[] {
  return invoiceReferenceKeys(invoiceNumber)
    .filter((k) => k.key.length >= MIN_REFERENCE_KEY_DIGITS)
    .filter((k) => k.form !== 'ocr' || validateOcrReference(k.key))
    .map((k) => k.key)
}
