/**
 * "Jag betalar i banken": what a person types into the bank's app for a
 * registered supplier invoice, read off the invoice as it was registered.
 *
 *   - where: the giro or IBAN the invoice states (payee_*), else the
 *     supplier card's; a bankgiro before a plusgiro before an IBAN. Never
 *     while a changed or new account waits for a person's decision (the
 *     payee hold, lib/payments/payee-alerts.ts): a changed bankgiro is how
 *     invoice fraud pays the wrong party, so the panel sends the person to
 *     the invoice instead of handing over the number to copy;
 *   - the reference: an OCR when the stated reference passes Bankgirot's
 *     check digit (10-modulen), else the reference as a message, else the
 *     invoice number as the message;
 *   - the amount still owed and the due date.
 *
 * Pure: the component reads the invoice and the payee view, this decides.
 *
 * payFromDocumentDetails is the same panel for a document nothing was
 * registered from (no Leverantörsfakturor under kontantmetoden): the same
 * rules read off the document's own reading, and the payment is booked with
 * the document when it reaches the bank.
 */
import type { InvoiceExtractionResult } from '@/types'
import { formatBankgiroNumber, formatPlusgiroNumber, validateOcrReference } from '@/lib/bankgiro/luhn'

/** The supplier invoice as GET /api/supplier-invoices/:id answers it, as far as this reads it. */
export interface PayInBankInvoice {
  supplier_invoice_number: string | null
  payment_reference: string | null
  payee_bankgiro?: string | null
  payee_plusgiro?: string | null
  payee_iban?: string | null
  status?: string | null
  total: number
  remaining_amount?: number | null
  currency?: string | null
  due_date?: string | null
  supplier?: { name?: string | null; bankgiro?: string | null; plusgiro?: string | null; iban?: string | null } | null
}

export type PayInBankAccount = { kind: 'bankgiro' | 'plusgiro' | 'iban'; value: string }

export interface PayInBankDetails {
  supplierName: string | null
  /** Null when there is none to show, or while the account waits for a person (`held`). */
  account: PayInBankAccount | null
  /** A changed or new account on the invoice waits for a person's decision. */
  held: boolean
  reference: { kind: 'ocr' | 'message'; value: string } | null
  amount: number
  currency: string
  dueDate: string | null
  /** Nothing is left to pay: it was settled, or it was an utlägg after all. */
  settled: boolean
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** A bankgiro before a plusgiro before an IBAN, each as a bank's form takes it. */
function firstAccount(bankgiro: string | null, plusgiro: string | null, iban: string | null): PayInBankAccount | null {
  if (bankgiro) return { kind: 'bankgiro', value: formatBankgiroNumber(bankgiro) }
  if (plusgiro) return { kind: 'plusgiro', value: formatPlusgiroNumber(plusgiro) }
  if (iban) return { kind: 'iban', value: iban.replace(/\s+/g, '').toUpperCase() }
  return null
}

function accountOf(invoice: PayInBankInvoice): PayInBankAccount | null {
  const card = invoice.supplier ?? {}
  return firstAccount(
    clean(invoice.payee_bankgiro) ?? clean(card.bankgiro),
    clean(invoice.payee_plusgiro) ?? clean(card.plusgiro),
    clean(invoice.payee_iban) ?? clean(card.iban),
  )
}

/** An OCR when the stated reference passes the check digit, else the reference as a message, else the invoice number. */
function referenceFrom(reference: string | null | undefined, invoiceNumber: string | null | undefined): PayInBankDetails['reference'] {
  const stated = clean(reference)
  if (stated) {
    const digits = stated.replace(/\s+/g, '')
    return validateOcrReference(digits) ? { kind: 'ocr', value: digits } : { kind: 'message', value: stated }
  }
  const number = clean(invoiceNumber)
  return number ? { kind: 'message', value: number } : null
}

function referenceOf(invoice: PayInBankInvoice): PayInBankDetails['reference'] {
  return referenceFrom(invoice.payment_reference, invoice.supplier_invoice_number)
}

export function payInBankDetails(invoice: PayInBankInvoice, payee: { hold: string | null } | null): PayInBankDetails {
  const held = !!payee?.hold
  const amount = Number(invoice.remaining_amount ?? invoice.total)
  return {
    supplierName: clean(invoice.supplier?.name),
    account: held ? null : accountOf(invoice),
    held,
    reference: referenceOf(invoice),
    amount,
    currency: (invoice.currency || 'SEK').toUpperCase(),
    dueDate: clean(invoice.due_date),
    settled: invoice.status === 'paid' || invoice.status === 'credited' || !(amount > 0),
  }
}

/** What payFromDocumentDetails reads off a document: the reading as the inbox stores it. */
export type PayFromDocumentReading = Pick<InvoiceExtractionResult, 'supplier' | 'invoice' | 'totals'>

export interface PayFromDocumentDetails {
  supplierName: string | null
  /** Null when the document states none, or while it is held (`held`). */
  account: PayInBankAccount | null
  /**
   * The document states another account than the company's supplier card
   * for the counterpart: the number is not handed over to copy, the person
   * checks it with the supplier first.
   */
  held: boolean
  reference: PayInBankDetails['reference']
  /** The document's total; null when the reading has none (or not a positive one). */
  amount: number | null
  currency: string
  dueDate: string | null
}

/**
 * The account the document asks to be paid to, in the shape the payee rules
 * read (lib/payments/payee-change.ts StatedPayeeSource), so the caller can
 * compare it with the supplier card before the number is shown.
 */
export function statedPayeeOfDocument(reading: PayFromDocumentReading | null | undefined): {
  payee_bankgiro: string | null
  payee_plusgiro: string | null
  payee_iban: string | null
} {
  return {
    payee_bankgiro: clean(reading?.supplier?.bankgiro),
    payee_plusgiro: clean(reading?.supplier?.plusgiro),
    payee_iban: clean(reading?.supplier?.iban),
  }
}

/**
 * "Jag betalar i banken" without Leverantörsfakturor: what to type in the
 * bank's app, read off the document itself (its giro or IBAN, its OCR or
 * message, its total and due date). Nothing is registered. `payee.held`
 * says the document's account differs from the supplier card's, decided by
 * the caller with the payee rules: then no number is handed over.
 */
export function payFromDocumentDetails(
  reading: PayFromDocumentReading | null | undefined,
  payee: { held: boolean } | null,
): PayFromDocumentDetails {
  const held = !!payee?.held
  const stated = statedPayeeOfDocument(reading)
  const total = reading?.totals?.total
  return {
    supplierName: clean(reading?.supplier?.name),
    account: held ? null : firstAccount(stated.payee_bankgiro, stated.payee_plusgiro, stated.payee_iban),
    held,
    reference: referenceFrom(reading?.invoice?.paymentReference, reading?.invoice?.invoiceNumber),
    amount: typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null,
    currency: (clean(reading?.invoice?.currency) ?? 'SEK').toUpperCase(),
    dueDate: clean(reading?.invoice?.dueDate),
  }
}

/** An amount as a bank's amount field takes it: two decimals, a decimal comma, no grouping. */
export function plainAmount(amount: number): string {
  return new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(amount)
}
