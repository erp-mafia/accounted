/**
 * What the invoice PDF's payment area (zone E, see ./geometry.ts) says, per
 * document type and status. The area has one fixed height on every document
 * that has one; only its words change, so a paid or cancelled re-render
 * paginates exactly like the original:
 *
 *   faktura, unpaid     Att betala, Förfallodatum, the payment rows, the QR code
 *   partly paid         Kvar att betala (the remainder every QR encodes) and
 *                       what was paid so far; rows and QR as unpaid
 *   paid                Kvar att betala 0,00; the same rows; "Betald {datum}"
 *                       in the QR slot instead of a code
 *   cancelled           "Makulerad, ska inte betalas" instead of rows; no code
 *   credited            "Krediterad, ska inte betalas" instead of rows; no code
 *   kreditfaktura       Att kreditera and the invoice it credits; no rows, no code
 *   offert              Summa, Giltig till and who to ask; no rows, no code
 *   proforma, följesedel  no payment area at all
 *
 * Pure: the template renders the model, tests read it directly.
 */
import type { Invoice, InvoiceDocumentType } from '@/types'
import { partlyPaidRemainder } from '@/lib/invoices/amount-due'
import {
  buildInvoicePaymentRows,
  type InvoicePaymentRowsCompany,
  type InvoicePaymentRowsInvoice,
} from '@/lib/invoices/payment-rows'
import type { InvoicePdfPaymentQr } from '@/lib/invoices/payment-qr'
import { bareLabel, formatPdfCurrency, formatPdfDate, type PdfLang } from './format'

/**
 * Payment state the PDF prints for a real faktura (#1693): the BETALD stamp
 * and the paid wording in the payment area. Null for every other document or
 * status, so unpaid invoices, credit notes and proformas carry none.
 *
 * `paid_amount` is what the customer actually paid; the deduction-aware amount
 * to pay is only the fallback for legacy rows marked paid before paid_amount
 * existed. `remaining_amount` is the row's own figure: 0 once fully paid.
 */
export interface PdfPaidState {
  kind: 'paid' | 'partially_paid'
  paidAmount: number
  remainingAmount: number
  /** ISO yyyy-MM-dd, or null when paid_at was never recorded. */
  paidDate: string | null
}

export function resolvePdfPaidState(
  invoice: Invoice,
  docType: InvoiceDocumentType,
  isCreditNote: boolean,
  amountToPay: number,
): PdfPaidState | null {
  if (isCreditNote || docType !== 'invoice') return null
  if (invoice.status !== 'paid' && invoice.status !== 'partially_paid') return null
  const paidAmount = invoice.paid_amount ?? (invoice.status === 'paid' ? amountToPay : 0)
  // The same remainder every payment QR encodes (lib/invoices/amount-due).
  const remainingAmount = invoice.status === 'paid' ? 0 : partlyPaidRemainder(invoice, amountToPay)
  return {
    kind: invoice.status,
    paidAmount,
    remainingAmount,
    paidDate: invoice.paid_at ? formatPdfDate(invoice.paid_at) : null,
  }
}

export const PAYMENT_AREA_LABELS = {
  sv: {
    kickerPayment: 'Betalning',
    kickerCredit: 'Kredit',
    kickerQuote: 'Offert',
    toPay: 'Att betala',
    remaining: 'Kvar att betala',
    paidSoFar: (amount: string) => `Betalt: ${amount}`,
    dueDate: 'Förfallodatum',
    toCredit: 'Att kreditera',
    creditsInvoice: 'Avser faktura',
    quoteTotal: 'Summa',
    validUntil: 'Giltig till',
    quoteQuestions: 'Frågor om offerten',
    email: 'E-post',
    phone: 'Telefon',
    paid: 'Betald',
    cancelled: 'Makulerad, ska inte betalas.',
    cancelledWithNumber: (n: string) =>
      `Faktura ${n} har makulerats. Numret behålls i serien för att hålla nummerföljden obruten enligt ML 17 kap 24§, men dokumentet är inte ett giltigt fakturaunderlag.`,
    cancelledNoNumber: 'Detta utkast har makulerats och är inte ett giltigt fakturaunderlag.',
    credited: 'Krediterad, ska inte betalas.',
  },
  en: {
    kickerPayment: 'Payment',
    kickerCredit: 'Credit',
    kickerQuote: 'Quote',
    toPay: 'Total due',
    remaining: 'Balance due',
    paidSoFar: (amount: string) => `Paid: ${amount}`,
    dueDate: 'Due date',
    toCredit: 'To credit',
    creditsInvoice: 'Credits invoice',
    quoteTotal: 'Total',
    validUntil: 'Valid until',
    quoteQuestions: 'Questions about this quote',
    email: 'Email',
    phone: 'Phone',
    paid: 'Paid',
    cancelled: 'Void, do not pay.',
    cancelledWithNumber: (n: string) =>
      `Invoice ${n} has been voided. The number is retained in the sequence to keep the numbering unbroken (ML 17 kap 24§, Swedish VAT Act), but this document is not a valid invoice.`,
    cancelledNoNumber: 'This draft has been voided and is not a valid invoice.',
    credited: 'Credited, do not pay.',
  },
} as const

export interface PdfPaymentAreaRow {
  key: string
  /** Without a trailing colon: the area prints label and value as two columns. */
  label: string
  value: string
  /** The payment reference the customer copies into the bank: printed bold. */
  emphasis: boolean
  /** A link target (the payment link row): the value is a shortened display form. */
  href?: string
}

export type PdfPaymentAreaSlot =
  | { kind: 'qr'; qr: InvoicePdfPaymentQr }
  | { kind: 'paid'; title: string; date: string | null; amount: string }

export interface PdfPaymentArea {
  /** The small caps heading: Betalning, Kredit, Offert. */
  kicker: string
  amountLabel: string
  amount: number
  currency: string
  /** A quiet line under the amount: what a partly paid invoice has received. */
  amountNote: string | null
  /** The one date or reference under the amount. */
  detail: { label: string; value: string } | null
  /** The middle column. Empty on a credit note. */
  rows: PdfPaymentAreaRow[]
  /** Replaces the rows on a cancelled or credited invoice. */
  status: { headline: string; text: string | null } | null
  /** The right column: the one QR code, the paid marker, or nothing. */
  slot: PdfPaymentAreaSlot | null
}

export interface PdfPaymentAreaInput {
  invoice: InvoicePaymentRowsInvoice &
    Pick<Invoice, 'status' | 'due_date'> & {
      our_reference?: string | null
      valid_until?: string | null
    }
  /** The company with the invoice's payee applied, as the PDF renders it. */
  company: InvoicePaymentRowsCompany & { email?: string | null; phone?: string | null }
  lang: PdfLang
  docType: InvoiceDocumentType
  isCreditNote: boolean
  /** The grand total the totals block prints: Att betala, Att kreditera or the quote's Summa. */
  amountToPay: number
  paidState: PdfPaidState | null
  originalInvoiceNumber?: string
  paymentQr?: InvoicePdfPaymentQr | null
}

/** Whether the document has a payment area (and reserves its height). */
export function documentHasPaymentArea(docType: InvoiceDocumentType, isCreditNote: boolean): boolean {
  if (isCreditNote) return true
  return docType !== 'proforma' && docType !== 'delivery_note'
}

const LINK_DISPLAY_MAX_CHARS = 40

function shortLink(url: string): string {
  const display = url.replace(/^https?:\/\//, '')
  return display.length > LINK_DISPLAY_MAX_CHARS ? `${display.slice(0, LINK_DISPLAY_MAX_CHARS - 3)}...` : display
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function buildPdfPaymentArea(input: PdfPaymentAreaInput): PdfPaymentArea | null {
  const { invoice, company, lang, docType, isCreditNote, amountToPay, paidState } = input
  if (!documentHasPaymentArea(docType, isCreditNote)) return null
  const A = PAYMENT_AREA_LABELS[lang]
  const currency = invoice.currency ?? 'SEK'
  const money = (amount: number) => formatPdfCurrency(amount, currency, lang)
  const base = { currency, amountNote: null, detail: null, rows: [], status: null, slot: null }

  if (invoice.status === 'cancelled' && docType === 'invoice') {
    const number = clean(invoice.invoice_number)
    return {
      ...base,
      kicker: isCreditNote ? A.kickerCredit : A.kickerPayment,
      amountLabel: A.toPay,
      amount: 0,
      status: { headline: A.cancelled, text: number ? A.cancelledWithNumber(number) : A.cancelledNoNumber },
    }
  }

  if (isCreditNote) {
    return {
      ...base,
      kicker: A.kickerCredit,
      amountLabel: A.toCredit,
      amount: amountToPay,
      detail: input.originalInvoiceNumber ? { label: A.creditsInvoice, value: input.originalInvoiceNumber } : null,
    }
  }

  if (docType === 'quote') {
    const contacts: PdfPaymentAreaRow[] = []
    const contact = (key: string, label: string, value: string | null | undefined) => {
      const v = clean(value)
      if (v) contacts.push({ key, label, value: v, emphasis: false })
    }
    contact('our_reference', A.quoteQuestions, invoice.our_reference)
    contact('email', A.email, company.email)
    contact('phone', A.phone, company.phone)
    return {
      ...base,
      kicker: A.kickerQuote,
      amountLabel: A.quoteTotal,
      amount: amountToPay,
      detail: { label: A.validUntil, value: formatPdfDate(invoice.valid_until || invoice.due_date) },
      rows: contacts,
    }
  }

  if (invoice.status === 'credited') {
    return { ...base, kicker: A.kickerPayment, amountLabel: A.toPay, amount: 0, status: { headline: A.credited, text: null } }
  }

  const rows: PdfPaymentAreaRow[] = buildInvoicePaymentRows({ company, invoice, lang }).map((row) => ({
    key: row.key,
    label: bareLabel(row.label),
    value: row.key === 'payment_link' ? shortLink(row.value) : row.value,
    emphasis: row.emphasis ?? false,
    ...(row.key === 'payment_link' ? { href: row.value } : {}),
  }))
  const dueDate = { label: A.dueDate, value: formatPdfDate(invoice.due_date) }

  if (paidState?.kind === 'paid') {
    return {
      ...base,
      kicker: A.kickerPayment,
      amountLabel: A.remaining,
      amount: 0,
      detail: dueDate,
      rows,
      slot: { kind: 'paid', title: A.paid, date: paidState.paidDate, amount: money(paidState.paidAmount) },
    }
  }

  const qrSlot: PdfPaymentAreaSlot | null = input.paymentQr ? { kind: 'qr', qr: input.paymentQr } : null

  if (paidState?.kind === 'partially_paid') {
    return {
      ...base,
      kicker: A.kickerPayment,
      amountLabel: A.remaining,
      amount: paidState.remainingAmount,
      amountNote: A.paidSoFar(money(paidState.paidAmount)),
      detail: dueDate,
      rows,
      slot: qrSlot,
    }
  }

  return {
    ...base,
    kicker: A.kickerPayment,
    amountLabel: A.toPay,
    amount: amountToPay,
    detail: dueDate,
    rows,
    slot: qrSlot,
  }
}
