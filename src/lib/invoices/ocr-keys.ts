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
 *
 * Bankgirot also lets a reference carry a length digit before the check digit
 * (316 -> 31658), and invoices printed by another system often use it
 * (crm#1170). That form names an invoice only when no invoice is named the
 * older ways (invoicesNamedInTiers, the one ranking every matcher reads).
 * Equality with the key derived here is the check: a reference whose length
 * digit or check digit does not fit equals no key.
 */

import { generateLengthDigitOcrReference, generateOcrReference, validateOcrReference } from '@/lib/bankgiro/luhn'
import { normalizeOcrReference } from './duplicate-payment-guard'

/**
 * `invoice_number`: the invoice number's bare digits, which is what the
 * matcher has always compared and what customers who type the number by hand
 * send. `ocr`: those digits plus the Luhn check digit, which is what the
 * invoice actually prints. `ocr_length`: those digits plus Bankgirot's length
 * digit and the Luhn check digit over both, what an invoice printed by
 * another system often carries, and what the company's own invoices carry
 * when it prints the length digit (invoiceOcrReference).
 */
export type InvoiceReferenceForm = 'invoice_number' | 'ocr' | 'ocr_length'

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
 * Keys already derived, by invoice number: a matcher scores every bank row of
 * a batch against the same loaded invoices, so the same numbers come back row
 * after row. Bounded: emptied when full, never stale (a number's keys never
 * change).
 */
const KEY_CACHE_LIMIT = 20_000
const keyCache = new Map<string, readonly InvoiceReferenceKey[]>()

/**
 * Every reference a payer could quote for this invoice, digit-normalised.
 * Empty when the invoice number carries no digits at all (nothing to match on).
 */
export function invoiceReferenceKeys(
  invoiceNumber: string | null | undefined,
): InvoiceReferenceKey[] {
  const raw = invoiceNumber ?? ''
  const cached = keyCache.get(raw)
  if (cached) return [...cached]
  const keys = deriveReferenceKeys(raw)
  if (keyCache.size >= KEY_CACHE_LIMIT) keyCache.clear()
  keyCache.set(raw, keys)
  return [...keys]
}

function deriveReferenceKeys(raw: string): InvoiceReferenceKey[] {
  const bare = normalizeOcrReference(raw)
  if (!bare) return []

  const keys: InvoiceReferenceKey[] = [{ key: bare, form: 'invoice_number' }]

  // generateOcrReference returns its input unchanged for out-of-range lengths,
  // in which case the normalised result is just `bare` again and adds nothing.
  const ocr = normalizeOcrReference(generateOcrReference(raw))
  if (ocr && ocr !== bare) keys.push({ key: ocr, form: 'ocr' })

  // Two digits longer than the bare number and one longer than the OCR, so
  // never equal to either of this invoice's own keys.
  const withLength = generateLengthDigitOcrReference(raw)
  if (withLength) keys.push({ key: withLength, form: 'ocr_length' })

  return keys
}

/**
 * The forms a reference is read in, strongest first. The bare number and the
 * OCR we print come first, exactly as they matched before the length-digit
 * form existed. One reference can be one invoice's bare number and another's
 * length-digit OCR (31658 is invoice 31658, and invoice 316 with its length
 * and check digits), so the length-digit form is read only when nothing in
 * the set is named the first way: a reference that matched before matches
 * the same invoices now.
 */
const REFERENCE_TIERS: readonly (readonly InvoiceReferenceForm[])[] = [['invoice_number', 'ocr'], ['ocr_length']]

/**
 * The one ranking of reference forms over a set of invoices: the invoices
 * `names` accepts with the forms of the strongest tier that names any, in
 * their order in `invoices`; empty when no tier names one. `names` says
 * whether the reader's evidence (a reference field, a bank text) names the
 * invoice by one of the given forms.
 */
export function invoicesNamedInTiers<T>(
  invoices: readonly T[],
  names: (invoice: T, forms: readonly InvoiceReferenceForm[]) => boolean,
): T[] {
  for (const forms of REFERENCE_TIERS) {
    const named = invoices.filter((invoice) => names(invoice, forms))
    if (named.length > 0) return named
  }
  return []
}

/**
 * The invoices an already digit-normalised bank reference names (or any of
 * several, when the payer gave more than one), ranked by
 * invoicesNamedInTiers. Whole-reference equality only, never a substring: a
 * check or length digit that does not fit names nothing. Read by the
 * single-row OCR pass, the Bankgirot split's parts and the categorize
 * intercept, so they cannot disagree on what a reference names.
 */
export function invoicesNamedByReference<T extends { invoice_number?: string | null }>(
  invoices: readonly T[],
  normalizedReferences: string | readonly string[],
): T[] {
  const references = new Set((typeof normalizedReferences === 'string' ? [normalizedReferences] : normalizedReferences).filter(Boolean))
  if (references.size === 0) return []
  const keysOf = new Map(invoices.map((invoice) => [invoice, invoiceReferenceKeys(invoice.invoice_number)] as const))
  return invoicesNamedInTiers(invoices, (invoice, forms) =>
    (keysOf.get(invoice) ?? []).some((k) => references.has(k.key) && forms.includes(k.form)),
  )
}

const ALL_FORMS: readonly InvoiceReferenceForm[] = ['invoice_number', 'ocr', 'ocr_length']

/**
 * The subset of keys distinctive enough to be trusted on their own: long
 * enough not to be a coincidence, and, for the OCR form, still carrying a
 * valid check digit (the length-digit form carries one by construction). Use
 * these when the key is searched for inside free text (description, merchant
 * name) or compared against a reference field whose provenance is unknown;
 * exact equality against a dedicated reference field needs no such floor.
 * `forms` narrows them to one tier when the reader ranks invoices against
 * each other (invoicesNamedInTiers).
 */
export function distinctiveReferenceKeys(
  invoiceNumber: string | null | undefined,
  forms: readonly InvoiceReferenceForm[] = ALL_FORMS,
): string[] {
  return invoiceReferenceKeys(invoiceNumber)
    .filter((k) => forms.includes(k.form))
    .filter((k) => k.key.length >= MIN_REFERENCE_KEY_DIGITS)
    .filter((k) => k.form !== 'ocr' || validateOcrReference(k.key))
    .map((k) => k.key)
}
