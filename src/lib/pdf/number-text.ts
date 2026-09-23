/**
 * Sign guard for numbers rendered with @react-pdf/renderer.
 *
 * `Intl.NumberFormat('sv-SE')` and `toLocaleString('sv-SE')` write negatives
 * with U+2212 MINUS SIGN, not the ASCII hyphen-minus. The bundled standard
 * PDF fonts (Helvetica, Courier, Times: WinAnsi encoding) have no glyph for
 * U+2212, so react-pdf emits an unmapped byte and the viewer draws nothing:
 * a loss prints as a profit, a credit note as a charge (issue #1982, first
 * seen on Årets resultat in the årsredovisning PDF).
 *
 * Run every locale-formatted amount through this before it reaches a <Text>
 * that uses a standard font. Embedded TrueType fonts do carry the glyph, but
 * the ASCII hyphen renders identically there, so applying it everywhere is
 * safe.
 */

/** Built via fromCharCode so no editor or transport can normalise it away. */
export const UNICODE_MINUS = String.fromCharCode(0x2212)

/** "-0", "-0,00", "-0.00": a negated zero or sub-öre rounding noise. */
const NEGATIVE_ZERO = /^-0(?:[.,]0+)?$/

/**
 * Locale-formatted number text made safe for a standard PDF font: U+2212
 * becomes the ASCII hyphen-minus, and a negative zero (which the dropped
 * glyph used to hide) prints unsigned, as it does on screen.
 */
export function pdfNumberText(text: string): string {
  const ascii = text.replaceAll(UNICODE_MINUS, '-')
  return NEGATIVE_ZERO.test(ascii) ? ascii.slice(1) : ascii
}

/**
 * Free text (a formula, a label) made safe for a standard PDF font: U+2212
 * becomes the ASCII hyphen-minus. Unlike pdfNumberText it never touches a
 * leading "-0", because the text is not a single number.
 */
export function pdfText(text: string): string {
  return text.replaceAll(UNICODE_MINUS, '-')
}

/**
 * Two-decimal sv-SE amount for a react-pdf <Text>: the same Intl call as
 * lib/utils formatAmount, run through pdfNumberText so a negative årets
 * resultat or a credit note never prints unsigned (issue #1982).
 */
export function pdfAmount(amount: number): string {
  return pdfNumberText(
    new Intl.NumberFormat('sv-SE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount),
  )
}

/** ISO date string as sv-SE (YYYY-MM-DD in the server timezone); empty input stays empty. */
export function formatDateSv(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('sv-SE')
}
