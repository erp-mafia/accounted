/**
 * Currencies Riksbanken publishes a SEK rate for: SWEA group 130, series
 * SEK<code>PMI, quoted in SEK per ONE unit of the currency. Read from
 * Riksbanken's series list on 2026-10-11: every open series, plus the four
 * closed since 2022 (BGN, MAD, RUB, SAR), which still answer for dates before
 * they closed and have no observation after.
 *
 * A checked list, not SEK<any code>PMI: Riksbanken answers an unknown series
 * with an empty 204, so a mistyped code would cost a request against the
 * per-IP limit and read as "no rate yet", and a series is trusted only once
 * its quoting unit has been read. This is the set a RATE exists for. The set
 * the app can invoice in is CURRENCIES in types/index.ts, a subset
 * (currencies.test.ts pins that).
 *
 * A module of its own, free of the client, so a schema can list the set at
 * load (lib/operations/exchange-rates.ts) where tests stand in for the client.
 */
export const RIKSBANKEN_CURRENCIES: readonly string[] = [
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MAD', 'MXN', 'MYR', 'NOK',
  'NZD', 'PHP', 'PLN', 'RON', 'RUB', 'SAR', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]
