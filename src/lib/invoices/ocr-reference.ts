// Loose on purpose: rows written before invoice_show_ocr existed reach the
// templates with the flag undefined, which is why both callers default it.
type OcrSettings = {
  invoice_show_ocr?: boolean | null
  bankgiro?: string | null
  plusgiro?: string | null
}

/**
 * Whether the invoice carries an OCR reference (invoice number + Luhn check
 * digit) as its payment reference. Shared by the PDF payment box and the
 * invoice email so the two never show different references for one faktura:
 * the OCR row exists only for a Swedish-language invoice paid to a bankgiro
 * or plusgiro, and only while the company has not switched it off.
 */
export function invoiceShowsOcrReference(company: OcrSettings, lang: 'sv' | 'en'): boolean {
  return (company.invoice_show_ocr ?? true) && !!(company.bankgiro || company.plusgiro) && lang === 'sv'
}
