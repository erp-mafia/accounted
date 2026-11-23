import { generateLengthDigitOcrReference, generateOcrReference } from '@/lib/bankgiro/luhn'

// Loose on purpose: rows written before the invoice_show_* flags existed
// reach the templates with them undefined, which is why each flag defaults
// here, once, for every caller.
type GiroPrintSettings = {
  bankgiro?: string | null
  plusgiro?: string | null
  invoice_show_bankgiro?: boolean | null
  invoice_show_plusgiro?: boolean | null
}

type OcrFormSettings = {
  invoice_ocr_length_digit?: boolean | null
}

type OcrSettings = GiroPrintSettings & OcrFormSettings & {
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
 * Whether the invoice carries an OCR reference (invoiceOcrReference) as its
 * payment reference. Shared by the PDF payment box, the
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
 * The OCR reference the company's invoices carry for an invoice number: its
 * digits and a Luhn (10-modulen) check digit, with Bankgirot's length digit
 * between the two when the company has switched it on
 * (company_settings.invoice_ocr_length_digit). Invoice 0073 is paid as 00737,
 * or as 007369 with the length digit.
 *
 * Which of the two a bankgiro accepts is set in the company's agreement with
 * its bank: an OCR control of the check digit alone takes either, one that
 * also checks the length takes only a reference whose length digit fits, and
 * the payer's bank refuses the other at entry (Bankgirot, "Bankgiro
 * Inbetalningar Användarmanual", OCR-referenskontroll). So the form is the
 * company's to choose, and every place that states the OCR of an invoice
 * reads it here: the payment reference below and the Peppol PaymentID.
 *
 * A number the length-digit form cannot carry (more than 23 digits) keeps
 * the plain form.
 */
export function invoiceOcrReference(company: OcrFormSettings, invoiceNumber: string): string {
  if (company.invoice_ocr_length_digit) {
    return generateLengthDigitOcrReference(invoiceNumber) ?? generateOcrReference(invoiceNumber)
  }
  return generateOcrReference(invoiceNumber)
}

/**
 * How a payment reference is built. `ocr`: the digits of the invoice number
 * followed by a Luhn (10-modulen) check digit, with Bankgirot's length digit
 * before the check digit when the company prints one (invoiceOcrReference).
 * `invoice_number`: the invoice number as it is, written as the message of
 * the payment.
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
    return { type: 'ocr', reference: number ? invoiceOcrReference(company, number) : null }
  }
  return { type: 'invoice_number', reference: number }
}
