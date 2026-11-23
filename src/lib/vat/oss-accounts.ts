import { isVatBoxAccount } from './account-vat-box'
import { EU_COUNTRIES, isOtherEuCountry } from './eu-countries'

/**
 * OSS accounts that name their country (unionsordningen).
 *
 * The OSS declaration is per country of consumption and VAT rate. A webshop
 * order row carries both. A verifikat booked without an order does not, so
 * the account says it instead: a company that books OSS sales by hand, from
 * invoices or from an imported ledger keeps one sales account per country
 * and rate, and usually one output VAT account per country
 * (chart_of_accounts.oss_country, oss_vat_rate).
 *
 *   - A sales account is a class 3 account with VAT code OSS. It names one
 *     other EU country and that country's rate: the pair places its sales.
 *   - A VAT account is a 26xx account other than 2650. It names the country
 *     whose OSS output VAT it holds, or every EU country when one account is
 *     shared. It takes no rate: the VAT follows the sale it is booked with.
 *
 * The rules here are the ones the write (./oss-account-countries.ts) and the
 * OSS underlag (lib/webshop-orders/oss-underlag.ts) share.
 */

export type OssAccountKind = 'sales' | 'vat'

/** On a VAT account: the account holds the OSS output VAT of every EU country. */
export const OSS_ALL_EU_COUNTRIES = 'EU'

/**
 * What an account can be in the OSS underlag, or null when it can name no
 * country. VAT code OSS makes a sales account (only a class 3 account can
 * carry that code); a VAT account is any that can feed a momsruta, which
 * leaves out the momsredovisning account.
 */
export function ossAccountKind(account: {
  account_number: string
  default_vat_treatment?: string | null
}): OssAccountKind | null {
  if (account.default_vat_treatment === 'oss') return 'sales'
  return isVatBoxAccount(account.account_number) ? 'vat' : null
}

/** Whether `country` is one an account of this kind may name. */
export function isOssAccountCountry(kind: OssAccountKind, country: string): boolean {
  if (kind === 'vat' && country === OSS_ALL_EU_COUNTRIES) return true
  return country === country.toUpperCase() && isOtherEuCountry(country)
}

/**
 * A VAT rate in percent with at most two decimals, above 0 and below 100.
 * The slack is what binary floating point adds to a two-decimal number
 * (25.55 × 100 is 2554.9999999999995), far below a third decimal: a writer
 * rounds the rate to two decimals before it stores it.
 */
export function isOssVatRate(rate: unknown): rate is number {
  return (
    typeof rate === 'number'
    && Number.isFinite(rate)
    && rate > 0
    && rate < 100
    && Math.abs(rate * 100 - Math.round(rate * 100)) < 1e-6
  )
}

/** Words that name each other EU country in an account name: Swedish, English and the usual by-names. */
const COUNTRY_WORDS: ReadonlyArray<readonly [string, string]> = [
  ...EU_COUNTRIES.filter((country) => country.code !== 'SE').flatMap(
    (country) => [[country.name, country.code], [country.nameEn, country.code]] as const,
  ),
  ['Holland', 'NL'],
  ['Czechia', 'CZ'],
]

const COUNTRY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = COUNTRY_WORDS.map(([word, code]) => [
  // Whole words only: "Irland" is not in "Nordirland".
  new RegExp(`(?<!\\p{L})${word.toLocaleLowerCase('sv-SE')}(?!\\p{L})`, 'u'),
  code,
])

/** A country code set in brackets, "(DE)": a bare "DE" or "IT" is a word in too many names. */
const BRACKETED_CODE = /\(([A-Z]{2})\)/g

/** A rate stated in the name: "19 %", "25,5%", "7 procent". */
const NAMED_RATE = /(?<![\d,.])(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%|procent(?!\p{L}))/gu

export interface OssAccountSuggestion {
  /** ISO 3166-1 alpha-2, or null when the name states no single other EU country. */
  country: string | null
  /** Percent, or null when the name states no single rate. */
  vat_rate: number | null
}

/**
 * The country and rate an account's NAME states, for a chart laid out as one
 * account per country: "Försäljning enl. OSS (Spanien 21%)", "Utgående moms
 * Tyskland". Each is null when the name states none or more than one. A
 * suggestion only: the account names its country when a person or an agent
 * sets it, never because of its name.
 */
export function suggestOssAccount(accountName: string): OssAccountSuggestion {
  const lower = accountName.toLocaleLowerCase('sv-SE')
  const countries = new Set<string>()
  for (const [pattern, code] of COUNTRY_PATTERNS) {
    if (pattern.test(lower)) countries.add(code)
  }
  for (const match of accountName.matchAll(BRACKETED_CODE)) {
    if (isOtherEuCountry(match[1])) countries.add(match[1])
  }

  const rates = new Set<number>()
  for (const match of lower.matchAll(NAMED_RATE)) {
    const rate = Number(match[1].replace(',', '.'))
    if (isOssVatRate(rate)) rates.add(rate)
  }

  return {
    country: countries.size === 1 ? [...countries][0] : null,
    vat_rate: rates.size === 1 ? [...rates][0] : null,
  }
}
