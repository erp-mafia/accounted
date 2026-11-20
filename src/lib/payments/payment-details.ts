/**
 * The payment details a document states for its payee (bankgiro, plusgiro,
 * IBAN, BIC), each validated on its own. Supplier invoices keep them as the
 * invoice's stated payee and fill the supplier card's gaps with them
 * (lib/supplier-invoices/payment-details-backfill.ts); payments compares the
 * stated payee with the card before it pays.
 */
import { formatBankgiroNumber, formatPlusgiroNumber, validateBankgiroNumber, validatePlusgiroNumber } from '@/lib/bankgiro/luhn'
import { normalizeIban } from '@/lib/cash-accounts/ledger-slots'

/**
 * The payment details a scanned or Peppol-delivered invoice carries for its
 * supplier. The extraction reads them together with everything else on the
 * invoice; until now they were only used when a NEW supplier was created
 * from the document, so an existing supplier without a bankgiro stayed
 * without one and its invoices could never go into a betalfil.
 */
export interface SupplierPaymentDetails {
  bankgiro?: string | null
  plusgiro?: string | null
  iban?: string | null
  bic?: string | null
}

/** ISO 7064 mod 97-10 over the rearranged IBAN; the cheap check that rejects a misread digit. */
export function isValidIban(raw: string | null | undefined): boolean {
  const iban = normalizeIban(raw)
  if (!iban || !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const value = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

export function isValidBic(raw: string | null | undefined): boolean {
  const bic = (raw ?? '').replace(/\s+/g, '').toUpperCase()
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)
}

/**
 * The details worth writing: each one validated on its own, so a misread
 * bankgiro never blocks a correct IBAN, and nothing invalid is ever stored.
 */
export function cleanSupplierPaymentDetails(details: SupplierPaymentDetails | null | undefined): SupplierPaymentDetails {
  const out: SupplierPaymentDetails = {}
  const bg = (details?.bankgiro ?? '').trim()
  if (bg && validateBankgiroNumber(bg)) out.bankgiro = formatBankgiroNumber(bg)
  const pg = (details?.plusgiro ?? '').trim()
  if (pg && validatePlusgiroNumber(pg)) out.plusgiro = formatPlusgiroNumber(pg)
  if (isValidIban(details?.iban)) out.iban = normalizeIban(details?.iban) as string
  if (isValidBic(details?.bic)) out.bic = (details?.bic ?? '').replace(/\s+/g, '').toUpperCase()
  return out
}

/** supplier_invoices.payee_* columns: the payee the invoice document states. */
export interface StatedPayeeColumns {
  payee_bankgiro: string | null
  payee_plusgiro: string | null
  payee_iban: string | null
  payee_bic: string | null
}

/**
 * The payee a document states, validated the same way as the backfill, as
 * the supplier invoice's own columns. Unlike the backfill this never defers
 * to the supplier card: the invoice keeps what IT says, so a payment can
 * compare the two and stop on a changed account instead of silently paying
 * whichever one it happened to read.
 */
export function statedPayeeColumns(details: SupplierPaymentDetails | null | undefined): StatedPayeeColumns {
  const clean = cleanSupplierPaymentDetails(details)
  return {
    payee_bankgiro: clean.bankgiro ?? null,
    payee_plusgiro: clean.plusgiro ?? null,
    payee_iban: clean.iban ?? null,
    payee_bic: clean.bic ?? null,
  }
}
