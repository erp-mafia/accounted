/**
 * The payment rows an invoice prints: ONE list for the PDF payment box, the
 * invoice email and the reminder email, so the customer never reads one
 * instruction in the mail and another on the faktura.
 *
 * Rows are computed from what PRINTS (a stored but hidden giro is no row),
 * in a fixed priority order, and capped at INVOICE_PAYMENT_ROW_LIMIT so the
 * payment area has a known height:
 *
 *   Bankgiro, Plusgiro, Bankkonto (bank + clearing + account in one row),
 *   Swish, IBAN, BIC, routing number / sort code / bank code by currency,
 *   Betala online, and exactly one reference row.
 *
 * The reference row is the OCR reference when a giro prints and the invoice
 * is Swedish (invoiceShowsOcrReference), otherwise "Meddelande" / "Reference"
 * with the invoice number. It always prints: when the method rows exceed the
 * budget, the lowest-priority method rows are the ones left out.
 *
 * The caller passes the company with the invoice's payee already applied
 * (companyWithInvoicePaymentAccount): this module reads the flat bank fields.
 *
 * Pure and isomorphic (no fs, no crypto): the invoice editor can import it.
 */
import type { Currency } from '@/types'
import { formatIbanGroups } from '@/lib/company/connection-iban'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import {
  invoicePrintsBankgiro,
  invoicePrintsPlusgiro,
  invoiceShowsOcrReference,
} from '@/lib/invoices/ocr-reference'
import { bankCodeLabelKey } from '@/lib/invoices/payment-accounts'

// Swish on invoices (the number row + the payment QR). When true, the Swish
// row and QR can print and the settings "Visa Swish" toggle is live.
export const SHOW_SWISH_ON_INVOICE = true

/** At most this many payment rows, the reference row included. */
export const INVOICE_PAYMENT_ROW_LIMIT = 7

export type InvoicePaymentRowKey =
  | 'bankgiro'
  | 'plusgiro'
  | 'bank_account'
  | 'swish'
  | 'iban'
  | 'bic'
  | 'routing_number'
  | 'sort_code'
  | 'bank_code'
  | 'payment_link'
  | 'ocr'
  | 'message'

export interface InvoicePaymentRow {
  key: InvoicePaymentRowKey
  label: string
  value: string
  /** The payment reference the customer copies into the bank: printed bold. */
  emphasis?: boolean
}

type Lang = 'sv' | 'en'

/** Labels shared by the PDF and the emails, so both say the same thing. */
export const INVOICE_PAYMENT_ROW_LABELS: Record<Lang, Record<InvoicePaymentRowKey, string>> = {
  sv: {
    bankgiro: 'Bankgiro:',
    plusgiro: 'Plusgiro:',
    bank_account: 'Bankkonto:',
    swish: 'Swish:',
    iban: 'IBAN:',
    bic: 'BIC/SWIFT:',
    routing_number: 'Routing number (ABA):',
    sort_code: 'Sort code:',
    bank_code: 'Bankkod:',
    payment_link: 'Betala online:',
    // The value is the OCR reference (invoice number + Luhn check digit),
    // never the bare invoice number.
    ocr: 'OCR/Referens:',
    message: 'Meddelande:',
  },
  en: {
    bankgiro: 'Bankgiro:',
    plusgiro: 'Plusgiro:',
    bank_account: 'Bank account:',
    swish: 'Swish:',
    iban: 'IBAN:',
    bic: 'BIC/SWIFT:',
    routing_number: 'Routing number (ABA):',
    sort_code: 'Sort code:',
    bank_code: 'Bank code:',
    payment_link: 'Pay online:',
    ocr: 'Reference:',
    message: 'Reference:',
  },
}

/** The payee fields and print switches the rows read (payee already applied). */
export interface InvoicePaymentRowsCompany {
  bank_name?: string | null
  clearing_number?: string | null
  account_number?: string | null
  bankgiro?: string | null
  plusgiro?: string | null
  swish?: string | null
  iban?: string | null
  bic?: string | null
  bank_code?: string | null
  foreign_account_number?: string | null
  invoice_show_bankgiro?: boolean | null
  invoice_show_plusgiro?: boolean | null
  invoice_show_swish?: boolean | null
  invoice_show_ocr?: boolean | null
}

export interface InvoicePaymentRowsInvoice {
  invoice_number?: string | null
  currency?: string | null
  payment_link_url?: string | null
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** Whether the invoice prints a Swish row: a number is set and the company shows it. */
export function invoicePrintsSwish(company: Pick<InvoicePaymentRowsCompany, 'swish' | 'invoice_show_swish'>): boolean {
  return SHOW_SWISH_ON_INVOICE && !!clean(company.swish) && (company.invoice_show_swish ?? false)
}

/**
 * The account row: the bank name with the domestic account (clearing and
 * account number, printed only when BOTH are set: half an account cannot be
 * paid to), or with the foreign account number of a non-IBAN payee.
 */
function bankAccountValue(company: InvoicePaymentRowsCompany): string | null {
  const clearing = clean(company.clearing_number)
  const account = clean(company.account_number)
  const number = clearing && account ? `${clearing}-${account}` : clean(company.foreign_account_number)
  if (!number) return null
  const bank = clean(company.bank_name)
  return bank ? `${bank}, ${number}` : number
}

/**
 * Swish numbers are stored as bare digits; print them the way Swedes read
 * them: a business number (123) as "123 118 11 89", a mobile number as
 * "070-123 45 67". Anything else prints as stored.
 */
export function formatSwishForDisplay(value: string | null): string | null {
  if (!value) return value
  const digits = value.replace(/\D/g, '')
  if (digits.length !== 10) return value
  if (digits.startsWith('123')) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`
  if (digits.startsWith('07')) return `${digits.slice(0, 3)}-${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`
  return value
}

/** IBANs print in groups of four ("SE45 5000 0000 ..."), as banks show them. */
export function formatIbanForDisplay(value: string | null): string | null {
  if (!value) return value
  return formatIbanGroups(value.replace(/\s/g, '').toUpperCase())
}

export function buildInvoicePaymentRows({
  company,
  invoice,
  lang,
}: {
  company: InvoicePaymentRowsCompany
  invoice: InvoicePaymentRowsInvoice
  lang: Lang
}): InvoicePaymentRow[] {
  const L = INVOICE_PAYMENT_ROW_LABELS[lang]
  const methods: InvoicePaymentRow[] = []
  const push = (key: InvoicePaymentRowKey, value: string | null) => {
    if (value) methods.push({ key, label: L[key], value })
  }

  push('bankgiro', invoicePrintsBankgiro(company) ? clean(company.bankgiro) : null)
  push('plusgiro', invoicePrintsPlusgiro(company) ? clean(company.plusgiro) : null)
  push('bank_account', bankAccountValue(company))
  push('swish', invoicePrintsSwish(company) ? formatSwishForDisplay(clean(company.swish)) : null)
  push('iban', formatIbanForDisplay(clean(company.iban)))
  push('bic', clean(company.bic))
  // Non-IBAN foreign routing: the label names the identifier the customer's
  // bank asks for (USD ABA routing number, GBP sort code).
  push(bankCodeLabelKey((invoice.currency ?? 'SEK') as Currency), clean(company.bank_code))
  push('payment_link', clean(invoice.payment_link_url))

  const invoiceNumber = clean(invoice.invoice_number)
  const reference: InvoicePaymentRow = invoiceShowsOcrReference(company, lang)
    ? { key: 'ocr', label: L.ocr, value: invoiceNumber ? generateOcrReference(invoiceNumber) : '-', emphasis: true }
    : { key: 'message', label: L.message, value: invoiceNumber ?? '-', emphasis: true }

  return [...methods.slice(0, INVOICE_PAYMENT_ROW_LIMIT - 1), reference]
}
