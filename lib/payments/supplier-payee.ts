/**
 * Payee and payment-reference resolution for supplier payment files.
 *
 * A payee is the routing target a payment instruction addresses. Suppliers
 * store their payment details across five columns of mixed quality
 * (bankgiro, plusgiro, structured clearing_number + account_number, and the
 * legacy free-text bank_account); this module is the single place that turns
 * them into a validated, discriminated payee or an explicit failure. Nothing
 * downstream may guess: an ambiguous digit blob must become 'payee_invalid',
 * never a payment to the wrong account.
 *
 * Priority mirrors the suppliers list page (bankgiro before plusgiro before
 * bank account) minus IBAN, which v1 does not pay to (SEK domestic only).
 */

import { validateBankgiroNumber, validatePlusgiroNumber, validateOcrReference } from '@/lib/bankgiro/luhn'
import { isValidAccount, isValidClearing } from '@/lib/salary/payment/bank-account'

export type SupplierPayee =
  | { type: 'bankgiro'; bankgiro: string }
  | { type: 'plusgiro'; plusgiro: string }
  | { type: 'bank_account'; clearing: string; account: string }

export type PayeeResolution =
  | { ok: true; payee: SupplierPayee }
  | { ok: false; reason: 'payee_missing' | 'payee_invalid' }

export interface SupplierPayeeSource {
  bankgiro: string | null
  plusgiro: string | null
  bank_account: string | null
  clearing_number?: string | null
  account_number?: string | null
}

/**
 * Free-text bank_account values are accepted only when they carry an explicit
 * clearing/account separator: "8327-9 123456789", "3300-1234567". A bare digit
 * blob cannot be split safely (is 83279123456789 clearing 8327 or 8327-9?),
 * so it resolves to payee_invalid.
 */
const FREE_TEXT_BANK_ACCOUNT = /^(\d{4}|8\d{4})[-\s]+([\d\s-]{5,15})$/

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

/**
 * Resolve the payee a supplier payment should be routed to, or an explicit
 * failure. A present-but-invalid value in a higher-priority field fails the
 * resolution rather than falling through: silently paying a supplier's
 * plusgiro because its bankgiro has a typo hides the typo forever.
 */
export function resolveSupplierPayee(supplier: SupplierPayeeSource): PayeeResolution {
  if (supplier.bankgiro?.trim()) {
    if (!validateBankgiroNumber(supplier.bankgiro)) return { ok: false, reason: 'payee_invalid' }
    return { ok: true, payee: { type: 'bankgiro', bankgiro: digits(supplier.bankgiro) } }
  }

  if (supplier.plusgiro?.trim()) {
    if (!validatePlusgiroNumber(supplier.plusgiro)) return { ok: false, reason: 'payee_invalid' }
    return { ok: true, payee: { type: 'plusgiro', plusgiro: digits(supplier.plusgiro) } }
  }

  const clearing = digits(supplier.clearing_number)
  const account = digits(supplier.account_number)
  if (clearing || account) {
    if (!isValidClearing(clearing) || !isValidAccount(account)) {
      return { ok: false, reason: 'payee_invalid' }
    }
    return { ok: true, payee: { type: 'bank_account', clearing, account } }
  }

  const freeText = supplier.bank_account?.trim()
  if (freeText) {
    const match = FREE_TEXT_BANK_ACCOUNT.exec(freeText)
    if (!match) return { ok: false, reason: 'payee_invalid' }
    const ftClearing = match[1]
    const ftAccount = digits(match[2])
    if (!isValidClearing(ftClearing) || !isValidAccount(ftAccount)) {
      return { ok: false, reason: 'payee_invalid' }
    }
    return { ok: true, payee: { type: 'bank_account', clearing: ftClearing, account: ftAccount } }
  }

  return { ok: false, reason: 'payee_missing' }
}

/** Human-readable payee label for previews and batch views: "BG 5050-1055". */
export function formatPayeeLabel(payee: SupplierPayee): string {
  switch (payee.type) {
    case 'bankgiro': {
      const bg = payee.bankgiro
      return `BG ${bg.slice(0, bg.length - 4)}-${bg.slice(-4)}`
    }
    case 'plusgiro': {
      const pg = payee.plusgiro
      return `PG ${pg.slice(0, pg.length - 1)}-${pg.slice(-1)}`
    }
    case 'bank_account':
      return `${payee.clearing} ${payee.account}`
  }
}

export type PaymentReference =
  | { type: 'ocr'; value: string }
  | { type: 'invoice_number'; value: string }

export interface PaymentReferenceSource {
  payment_reference: string | null
  supplier_invoice_number: string
}

/**
 * The reference the receiver uses to match the payment to the invoice.
 *
 * A Luhn-valid payment_reference is a real OCR number and rides the structured
 * rail (pain.001 CdtrRefInf SCOR). Anything else falls back to the supplier's
 * invoice number as a plain message: a mistyped OCR still reaches the supplier
 * as text a human can match, whereas a structured SCOR reference that fails
 * the receiver's OCR check can bounce the whole payment. Callers surface the
 * fallback-on-invalid case as a warning (ocrInvalid) so the typo gets fixed.
 */
export function resolvePaymentReference(invoice: PaymentReferenceSource): {
  reference: PaymentReference
  ocrInvalid: boolean
} {
  const raw = invoice.payment_reference?.trim()
  if (raw) {
    const ocr = digits(raw)
    if (validateOcrReference(ocr)) {
      return { reference: { type: 'ocr', value: ocr }, ocrInvalid: false }
    }
    return {
      reference: { type: 'invoice_number', value: invoice.supplier_invoice_number },
      ocrInvalid: true,
    }
  }
  return {
    reference: { type: 'invoice_number', value: invoice.supplier_invoice_number },
    ocrInvalid: false,
  }
}
