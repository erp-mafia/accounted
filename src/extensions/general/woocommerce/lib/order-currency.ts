/**
 * The order's currency as an ISO 4217 code, or null when it cannot be known.
 *
 * wc/v3 documents `order.currency` as an ISO code, and WooCommerce core
 * writes one, but plugins can write the order currency themselves and some
 * write the store's currency SYMBOL instead, HTML-encoded the way
 * WooCommerce's own symbol table stores it ("&#107;&#114;" is "kr", the SEK
 * symbol). Stored as-is, such a value reached Intl.NumberFormat as a currency
 * code on the Orders page (RangeError, whole page into the error boundary)
 * and left every row without a SEK amount, so it could never be booked.
 *
 * Rules, in order:
 * 1. Decode HTML entities, trim, uppercase. A code Intl recognises is the
 *    answer ("sek" and "SEK" both give SEK).
 * 2. Otherwise, a value that is one of the STORE currency's own symbols is
 *    the store currency: the plugin wrote the symbol of the currency the
 *    store runs in. The store currency comes from the woocommerce_currency
 *    setting, which WooCommerce keeps as a code. Its symbols are Intl's
 *    (sv-SE and en) plus WooCommerce's own symbol table entry, which is what
 *    a plugin copying the store symbol actually writes ("kr." for DKK).
 * 3. Anything else is refused (null). A multi-currency plugin writing "€"
 *    for a EUR order in a SEK store must never be read as SEK; the caller
 *    skips the order and says why.
 */

let supportedCodes: Set<string> | null = null

/** Whether `code` is an ISO 4217 code this runtime's Intl knows. */
export function isKnownCurrencyCode(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false
  if (supportedCodes === null) {
    supportedCodes = new Set(Intl.supportedValuesOf('currency'))
  }
  return supportedCodes.has(code)
}

/** Named entities WooCommerce's currency symbol table uses. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  nbsp: ' ',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  dollar: '$',
}

/** Decode the numeric and named HTML entities a currency value can carry. */
export function decodeCurrencyEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * WooCommerce's own symbol for a currency, decoded, from
 * get_woocommerce_currency_symbols() in wc-core-functions.php. Limited to the
 * currencies a Swedish seller plausibly runs a store in; other store
 * currencies still get Intl's symbols. Keyed by code, so a symbol only ever
 * counts for the store currency it belongs to: "kr." is DKK's and ISK's,
 * never SEK's ("kr").
 */
export const WOOCOMMERCE_CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  SEK: 'kr', // &#107;&#114;
  NOK: 'kr', // &#107;&#114;
  DKK: 'kr.',
  ISK: 'kr.',
  EUR: '€', // &euro;
  USD: '$', // &#36;
  GBP: '£', // &pound;
  CHF: 'CHF', // &#67;&#72;&#70;
  PLN: 'zł', // &#122;&#322;
}

/**
 * Every way the store currency is commonly written as a symbol, lowercased:
 * WooCommerce's own symbol table entry, plus Intl's symbol and narrow symbol
 * in Swedish and English ("kr" for SEK).
 */
function symbolsOf(code: string): Set<string> {
  const symbols = new Set<string>()
  const wooSymbol = WOOCOMMERCE_CURRENCY_SYMBOLS[code]
  if (wooSymbol) symbols.add(wooSymbol.toLowerCase())
  for (const locale of ['sv-SE', 'en']) {
    for (const currencyDisplay of ['symbol', 'narrowSymbol'] as const) {
      const part = new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay })
        .formatToParts(0)
        .find((p) => p.type === 'currency')
      if (part) symbols.add(part.value.trim().toLowerCase())
    }
  }
  return symbols
}

export function resolveOrderCurrency(
  raw: string | null | undefined,
  storeCurrency: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null
  const decoded = decodeCurrencyEntities(raw).trim()
  if (!decoded) return null
  const upper = decoded.toUpperCase()
  if (isKnownCurrencyCode(upper)) return upper

  const store = typeof storeCurrency === 'string' ? storeCurrency.trim().toUpperCase() : ''
  if (!isKnownCurrencyCode(store)) return null
  return symbolsOf(store).has(decoded.toLowerCase()) ? store : null
}
