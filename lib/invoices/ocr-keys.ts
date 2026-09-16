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

/**
 * True when `token` occurs in free text (a verifikat description, a bank memo)
 * as a reference rather than as a run of characters inside a longer number.
 *
 * Two rules, both of which the substring tests this replaced were missing:
 *
 *  - the same `MIN_REFERENCE_KEY_DIGITS` floor the OCR keys use. An ankomstnummer
 *    is a sequential counter, so a company has hundreds of one- to three-character
 *    tokens in circulation and every one of them turns up somewhere in some
 *    description;
 *  - digit adjacency. `14` inside `(1814)` is not a mention of 14. The guard is
 *    digit adjacency and not a word boundary because whitespace is stripped from
 *    both sides first (a source system may print a reference in groups), which
 *    leaves `faktura 1814` as `faktura1814`: there `\b` would reject the very
 *    case the match exists for.
 *
 * Exact equality against a dedicated reference field needs neither rule, which
 * is why `matchesNormalizedReference` has neither.
 */
export function textMentionsReference(
  text: string | null | undefined,
  token: string | null | undefined,
): boolean {
  if (!text || !token) return false
  const haystack = text.replace(/\s+/g, '').toLowerCase()
  const needle = token.replace(/\s+/g, '').toLowerCase()
  if (needle.length < MIN_REFERENCE_KEY_DIGITS) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<!\\d)${escaped}(?!\\d)`).test(haystack)
}
