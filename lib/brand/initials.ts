/**
 * Display initials for a counterparty mark.
 *
 * Deliberately dependency-free and separate from
 * `normalizeCounterpartyName()` (lib/bookkeeping/counterparty-templates.ts):
 * that module pulls in the Supabase client, VAT entry generation and the
 * dimension resolver, and this function runs in a client component rendered
 * once per visible row on the transactions list (PAGE_SIZE = 200). Importing
 * the canonical normalizer here would put all of that in the client bundle of
 * the app's heaviest page to compute two letters.
 *
 * The canonical normalizer stays the identity used for *resolving* a logo
 * server-side, so a merchant keeps one identity for learning and lookup. This
 * one only decides what to draw when no logo has been resolved yet.
 */

/**
 * Bank-feed prefixes that describe the payment rail rather than the
 * counterparty. Without stripping them, "Kortköp ICA Supermarket" yields "KI"
 * and every card purchase in the list shows the same two letters.
 */
const RAIL_PREFIXES = new Set([
  'kortkop', 'kortköp', 'kortbetalning', 'kort',
  'swish', 'autogiro', 'bg', 'pg', 'bankgiro', 'plusgiro',
  'betalning', 'inbetalning', 'utbetalning', 'overforing', 'överföring',
  'payment', 'purchase', 'card',
])

/** Strip accents so "Örebro" and "Orebro" hit the same prefix entry. */
function foldAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * A token contributes to the initials only if it starts with a letter: pure
 * amounts, dates, card-descriptor numbers and reference codes never do.
 */
function isSignificant(token: string): boolean {
  return /^\p{L}/u.test(token)
}

/**
 * Up to two uppercase letters standing for `raw`, or '' when the label carries
 * no letters at all (the caller then draws a neutral glyph instead).
 *
 * One word yields its first two letters ("Anthropic" to "AN"); several yield
 * the first letter of each of the first two ("Circle K" to "CK").
 */
export function brandInitials(raw: string | null | undefined): string {
  if (!raw) return ''

  const tokens = raw
    .trim()
    .split(/[\s\/,.*|-]+/u)
    .filter(Boolean)
    .filter(isSignificant)

  // Drop leading rail words, but never strip to nothing: a transaction whose
  // whole description is "Swish" should still read as "SW".
  let start = 0
  while (
    start < tokens.length - 1 &&
    RAIL_PREFIXES.has(foldAccents(tokens[start]).toLowerCase())
  ) {
    start += 1
  }
  const words = tokens.slice(start)
  if (words.length === 0) return ''

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase()
  }
  return (words[0][0] + words[1][0]).toUpperCase()
}
