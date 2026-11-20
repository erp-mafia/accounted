/**
 * The card a bank row was paid with, as far as the bank's own text names
 * it, against the card a receipt says it was paid with
 * (extracted_data.payment.cardLast4).
 *
 * A card statement row prints the card's last four digits as a token beside
 * the merchant: "X CORP. PAID FEATURES K3667", or a masked number
 * ("****3667", "XXXX 3667", "Kort 3667"). Only those shapes count: four
 * digits anywhere else in the text (an amount, a year, an order number) are
 * not a card. Pure: no client, no I/O.
 */

/** The shapes a card token takes in a bank row's text; each captures the last four digits. */
const CARD_TOKEN_PATTERNS: readonly RegExp[] = [
  // The bank's own card token: a capital K straight before the four digits, standing alone.
  /\bK(\d{4})\b/g,
  // A masked card number: asterisks or X's before the last four.
  /(?:\*{2,}|\bX{4,})\s?(\d{4})\b/gi,
  // Kort, kortnr or kortnummer before the four digits.
  /\bkort(?:nr|nummer)?[.:]?\s*\**\s*(\d{4})\b/gi,
]

/** Four digits, the way a card's last four are printed; anything else is no card. */
export function normaliseCardLast4(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const digits = value.replace(/[\s*•·xX.-]/g, '')
  return /^\d{4}$/.test(digits) ? digits : null
}

/** The card last-fours the texts name, each once, in the order found. */
export function cardTokensIn(texts: ReadonlyArray<string | null | undefined>): string[] {
  const found: string[] = []
  for (const text of texts) {
    if (!text) continue
    for (const pattern of CARD_TOKEN_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const digits = match[1]
        if (digits && !found.includes(digits)) found.push(digits)
      }
    }
  }
  return found
}

/**
 * What the row's card says about a document paid with `cardLast4`:
 *   - agrees: the row names that card;
 *   - contradicts: the row names a card, and never that one: another card
 *     paid it, so it is another payment;
 *   - none: the document names no card, or the row none.
 */
export type CardEvidence = 'agrees' | 'contradicts' | 'none'

export function cardEvidence(cardLast4: string | null | undefined, texts: ReadonlyArray<string | null | undefined>): CardEvidence {
  const card = normaliseCardLast4(cardLast4 ?? null)
  if (!card) return 'none'
  const tokens = cardTokensIn(texts)
  if (tokens.length === 0) return 'none'
  return tokens.includes(card) ? 'agrees' : 'contradicts'
}
