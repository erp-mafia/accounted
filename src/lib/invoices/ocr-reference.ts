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
