import type { CompanySettings } from '@/types'
import type { PdfLang } from '@/lib/invoices/pdf/format'

type FinePrintSettings = Pick<
  CompanySettings,
  'invoice_late_fee_text' | 'invoice_credit_terms_text' | 'invoice_late_fee_text_en' | 'invoice_credit_terms_text_en'
>

/** The company's fine print on one invoice, each text as stored or null when unset. */
export interface InvoiceFinePrint {
  /** Dröjsmålsränta: what a late payment costs. */
  lateFee: string | null
  /** Betalningsvillkor: the payment terms footnote. */
  creditTerms: string | null
}

// Blank and non-string values count as unset: a row can be written outside
// the settings schema (scripts, SQL), and a row read before the English
// columns exist has no value at all.
function storedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * The fine print in the invoice's language (crm#1735): on an English invoice
 * the company's English text of each, else its Swedish text, each falling
 * back on its own, so an English invoice never prints less than a Swedish
 * one would. A Swedish invoice prints the Swedish texts, as before. `lang`
 * is the invoice's document language (InvoicePDF's lang, the editor's
 * documentLanguage).
 */
export function invoiceFinePrint(settings: FinePrintSettings | null | undefined, lang: PdfLang): InvoiceFinePrint {
  const swedish: InvoiceFinePrint = {
    lateFee: storedText(settings?.invoice_late_fee_text),
    creditTerms: storedText(settings?.invoice_credit_terms_text),
  }
  if (lang !== 'en') return swedish
  return {
    lateFee: storedText(settings?.invoice_late_fee_text_en) ?? swedish.lateFee,
    creditTerms: storedText(settings?.invoice_credit_terms_text_en) ?? swedish.creditTerms,
  }
}
