import { UNICODE_MINUS } from '@/lib/pdf/number-text'

/**
 * Whole-krona amount formatting for text that react-pdf renders with the
 * built-in Helvetica font (the K2/K3 arsredovisning PDFs and their notes).
 *
 * `toLocaleString('sv-SE')` formats negative numbers with U+2212 MINUS SIGN,
 * which WinAnsi-encoded standard fonts cannot encode; react-pdf drops the
 * glyph silently, so a loss like -4 684 printed as "−4 684" loses its
 * sign and reads as a profit. Format the absolute value and prepend an ASCII
 * hyphen-minus instead. The sv-SE thousands separator (U+00A0 NBSP) is in
 * WinAnsi and renders fine.
 */
const NBSP = String.fromCharCode(0x00a0)

export function formatPdfKronor(amount: number): string {
  const rounded = Math.round(amount)
  // Pin the group separator to U+00A0: depending on the Node/ICU CLDR
  // version, sv-SE groups with U+00A0 or U+202F NARROW NO-BREAK SPACE, and
  // U+202F is missing from WinAnsi too (digits would silently run together).
  const grouped = Math.abs(rounded)
    .toLocaleString('sv-SE')
    .replace(/\s/g, NBSP)
  return rounded < 0 ? `-${grouped}` : grouped
}

/**
 * Whole kronor for the text of a note. A note body is printed twice: in the
 * PDF, and untagged in the iXBRL document, whose own number writer signs a
 * negative amount with U+2212 MINUS SIGN. The note writes that sign too, so
 * the filed document has one; the PDF templates turn it into a hyphen where
 * they take in the report (pdfTextDeep), as for every other text.
 */
export function formatNoteKronor(amount: number): string {
  const text = formatPdfKronor(amount)
  return text.startsWith('-') ? `${UNICODE_MINUS}${text.slice(1)}` : text
}
