import { generateOcrReference } from '@/lib/bankgiro/luhn'

// Loose on purpose: rows written before the invoice_show_* flags existed
// reach the templates with them undefined, which is why each flag defaults
// here, once, for every caller.
type GiroPrintSettings = {
  bankgiro?: string | null
  plusgiro?: string | null
  invoice_show_bankgiro?: boolean | null
  invoice_show_plusgiro?: boolean | null
}

type OcrSettings = GiroPrintSettings & {
  invoice_show_ocr?: boolean | null
}

/** Whether the invoice prints a Bankgiro row: the number is set and the company has not hidden it. */
export function invoicePrintsBankgiro(company: GiroPrintSettings): boolean {
  return !!company.bankgiro?.trim() && (company.invoice_show_bankgiro ?? true)
}

/** Whether the invoice prints a Plusgiro row: the number is set and the company has not hidden it. */
export function invoicePrintsPlusgiro(company: GiroPrintSettings): boolean {
  return !!company.plusgiro?.trim() && (company.invoice_show_plusgiro ?? true)
}

/**
 * Whether the invoice carries an OCR reference (invoice number + Luhn check
 * digit) as its payment reference. Shared by the PDF payment box, the
 * invoice email and the bank-app QR so the three never show different
 * references for one faktura: the OCR row exists only for a Swedish-language
 * invoice that PRINTS a bankgiro or plusgiro to pay it to, and only while the
 * company has not switched it off. A giro that is stored but hidden does not
 * count: an OCR with no giro on the page gives the customer nothing to pay to.
 */
export function invoiceShowsOcrReference(company: OcrSettings, lang: 'sv' | 'en'): boolean {
  return (
    (company.invoice_show_ocr ?? true) &&
    lang === 'sv' &&
    (invoicePrintsBankgiro(company) || invoicePrintsPlusgiro(company))
  )
}

/**
 * How a payment reference is built. `ocr`: the digits of the invoice number
 * followed by a Luhn (10-modulen) check digit, no length digit: invoice 0073
 * is paid as 00737. `invoice_number`: the invoice number as it is, written as
 * the message of the payment.
 */
export type InvoicePaymentReferenceType = 'ocr' | 'invoice_number'

export interface InvoicePaymentReference {
  type: InvoicePaymentReferenceType
  /** What the payer writes with the payment; null while the invoice has no number. */
  reference: string | null
}

/**
 * The reference an invoice asks the payer to quote: the OCR reference when
 * the invoice shows one (invoiceShowsOcrReference), otherwise its number.
 *
 * The ONE place that chooses between the two, for everything that says how
 * to pay an invoice: the PDF payment box and the mails (payment-rows.ts),
 * the bank-app QR (bank-payment-qr.ts), the digital mailbox
 * (digital-mailbox-send.ts) and the `payment_reference` field of the API and
 * MCP reads (payment-reference-fields.ts). Each of the first three chose on
 * its own before, and no API returned the choice, so an integrator who
 * delivered the invoice outside Accounted had to work out the check digit
 * to print the reference the invoice carries (crm#1886).
 *
 * `company` is the company with the invoice's payee already applied
 * (companyWithInvoicePaymentAccount), as for invoiceShowsOcrReference. The
 * bank match reads a payment under either form (ocr-keys.ts), so the choice
 * never decides whether a payment is recognised.
 */
export function invoicePaymentReference(
  company: OcrSettings,
  invoiceNumber: string | null | undefined,
  lang: 'sv' | 'en',
): InvoicePaymentReference {
  const number = invoiceNumber?.trim() || null
  if (invoiceShowsOcrReference(company, lang)) {
    return { type: 'ocr', reference: number ? generateOcrReference(number) : null }
  }
  return { type: 'invoice_number', reference: number }
}
