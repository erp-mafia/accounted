export type PdfLang = 'sv' | 'en'

/**
 * An amount as the PDF prints it, without the currency: "18 563,00" in
 * Swedish, "18,563.00" in English.
 */
export function formatPdfAmount(amount: number, language: PdfLang = 'sv'): string {
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'sv-SE', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    // sv-SE emits U+2212, which standard PDF fonts can silently drop. The
    // ASCII minus is supported by every allowed invoice font.
  }).format(amount).replaceAll('−', '-')
}

// Format currency with explicit ISO code so non-Swedish recipients see "1 234,56 SEK"
// instead of the Swedish symbol "kr". Decimal style + appended code works for any
// currency (SEK/EUR/USD) and avoids Intl's locale-specific symbol quirks.
export function formatPdfCurrency(amount: number, currency: string = 'SEK', language: PdfLang = 'sv'): string {
  return `${formatPdfAmount(amount, language)} ${currency}`
}

// Format date as ISO yyyy-MM-dd in both locales: universally unambiguous and
// matches the project's formatDate() convention (lib/utils.ts).
// Input is already a YYYY-MM-DD string from the DB, so slice avoids the
// new Date() + local-getter timezone hazard.
export function formatPdfDate(date: string): string {
  return date.slice(0, 10)
}

/** A label as a column heading or a stacked label prints it: without its trailing colon. */
export function bareLabel(label: string): string {
  return label.replace(/:\s*$/, '')
}
