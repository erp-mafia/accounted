/**
 * Where the seller of a purchase is, read off its document: Sweden, another
 * EU country or outside the EU. It decides how the purchase's VAT is booked
 * (Swedish input VAT, or omvänd betalningsskyldighet with the basis in ruta
 * 21 or 22) and which supplier type a new supplier card gets.
 *
 * Deterministic, and in this order, the first that answers wins:
 *   1. the VAT number's prefix (EL is Greece; XI, Northern Ireland, is the
 *      United Kingdom, which is right for the services this decides), when
 *      the number has its member state's format, except a Swedish number
 *      beside an address that names another country (swedishVatNumberAbroad),
 *      which decides nothing;
 *   2. the IBAN's country;
 *   3. a Swedish organisationsnummer (ten digits, the hyphen optional);
 *   4. a country named in the address as read, by the names the country
 *      pickers know (./country-codes.ts) in Swedish and English, the last
 *      one named winning (an address ends with its country), and a US state,
 *      by name or by its two letters, before a ZIP code.
 * Nothing guessed beyond that: an unknown seller stays unknown, and whether
 * it looks foreign (a foreign currency, an address that is not Swedish) is
 * said apart, so the caller can ask the person.
 *
 * Pure and client-safe: the Inkorg's one click
 * (lib/operations/inkorg-one-click.ts) and the supplier-invoice form's
 * "Ny leverantör" read the same answer.
 */
import { COUNTRY_OPTIONS, isAssignedCountryCode, vatNumberCountryPrefix } from './country-codes'
import { isEuMemberCountry } from './eu-countries'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { isMalformedEuVatNumber } from '@/lib/invariants/vat-number'

export type SellerRegion = 'se' | 'eu' | 'non_eu'

export type SellerCountrySource = 'vat_number' | 'iban' | 'org_number' | 'address'

export interface SellerCountry {
  /** ISO 3166-1 alpha-2, or null when nothing on the document names one. */
  country: string | null
  region: SellerRegion | null
  source: SellerCountrySource | null
}

/** What the reading says about the seller, as far as the country goes (the extraction's supplier block fits). */
export interface SellerIdentity {
  vatNumber?: string | null
  iban?: string | null
  orgNumber?: string | null
  address?: string | null
}

/** The supplier type each region registers as (suppliers.supplier_type). */
export type SupplierTypeForRegion = 'swedish_business' | 'eu_business' | 'non_eu_business'

const SWEDEN = 'SE'

export function regionOfCountry(country: string): SellerRegion {
  const code = country.toUpperCase()
  if (code === SWEDEN) return 'se'
  return isEuMemberCountry(code) ? 'eu' : 'non_eu'
}

export function supplierTypeForRegion(region: SellerRegion): SupplierTypeForRegion {
  if (region === 'se') return 'swedish_business'
  return region === 'eu' ? 'eu_business' : 'non_eu_business'
}

/** A Swedish organisationsnummer: ten digits, the hyphen before the last four optional (16 prefix allowed). */
const SWEDISH_ORG_NUMBER = /^(?:16)?\d{6}-?\d{4}$/

/**
 * The country a VAT number's prefix names. A prefix with no digits after it is
 * no VAT number, and neither is an EU prefix whose national part is not that
 * state's number: "SESL000D", a US seller's VAT-code label, read as Sweden and
 * sent a reverse-charge purchase to Swedish input VAT (crm#1411). The next
 * source in the order decides then.
 */
function vatNumberCountry(vatNumber: string | null | undefined): string | null {
  const prefix = vatNumberCountryPrefix(vatNumber)
  if (!prefix || !/\d/.test(vatNumber ?? '') || isMalformedEuVatNumber(vatNumber)) return null
  if (prefix === 'EL') return 'GR'
  if (prefix === 'XI') return 'GB'
  return prefix
}

function ibanCountry(iban: string | null | undefined): string | null {
  const match = iban?.replace(/\s/g, '').toUpperCase().match(/^([A-Z]{2})\d{2}[A-Z0-9]{8,30}$/)
  return match ? match[1] : null
}

/**
 * Country names as an address prints them: every name the pickers know, in
 * Swedish and English, and the spellings addresses use beside them.
 */
const COUNTRY_NAMES: ReadonlyArray<readonly [string, string]> = [
  // "Island" (Iceland in Swedish) is an English word in addresses (Rhode Island, Long Island).
  ...COUNTRY_OPTIONS.flatMap((c) => [[c.nameEn, c.code] as const, [c.name, c.code] as const]).filter(([name]) => name !== 'Island'),
  ['Northern Ireland', 'GB'],
  ['Nordirland', 'GB'],
  ['United States of America', 'US'],
  ['U.S.A.', 'US'],
  ['Förenta staterna', 'US'],
  ['Great Britain', 'GB'],
  ['England', 'GB'],
  ['Scotland', 'GB'],
  ['Skottland', 'GB'],
  ['Wales', 'GB'],
  ['Deutschland', 'DE'],
  ['Czechia', 'CZ'],
  ['Holland', 'NL'],
]

const US_STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida',
  'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
  'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma',
  'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
]

const US_STATE_CODES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY'

/** What may follow a US ZIP: the end, a comma or line break, or the country's name. */
const AFTER_ZIP = '(?=\\s*(?:$|[,\\n]|USA\\b|U\\.S\\.A\\.|United States))'

/**
 * A state's two letters after the city's comma and before a five-digit ZIP
 * (optionally ZIP+4) that ends the line: "San Francisco, CA 94107". The ZIP
 * ending it keeps a European postcode with its country prefix ("DE 10117
 * Berlin") from reading as one.
 */
const US_STATE_ZIP = new RegExp(`,\\s*(?:${US_STATE_CODES})\\.?\\s+\\d{5}(?:-\\d{4})?${AFTER_ZIP}`, 'g')

/** A state named in full before a ZIP code: "Austin, Texas 78701". */
const US_STATE_NAME_ZIP = new RegExp(`\\b(?:${US_STATE_NAMES.join('|')})\\s*,?\\s+\\d{5}(?:-\\d{4})?${AFTER_ZIP}`, 'gi')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Letters on both sides decide a word: å, ä, ö and é count as letters. */
const NAME_PATTERNS: ReadonlyArray<{ re: RegExp; code: string }> = COUNTRY_NAMES.map(([name, code]) => ({
  re: new RegExp(`(?<![\\p{L}])${escapeRegExp(name)}(?![\\p{L}])`, 'giu'),
  code,
}))

/**
 * The country an address names, or null. The last name in the text wins (an
 * address ends with its country, and a street can be called Ireland Road);
 * a name inside a longer one (Ireland in Northern Ireland) is never counted
 * on its own.
 */
export function countryFromAddress(address: string | null | undefined): string | null {
  const named = namedCountries(address)
  if (named.length === 0) return null
  return named.reduce((last, one) => (one.at > last.at ? one : last)).code
}

interface NamedCountry {
  at: number
  end: number
  code: string
}

/** Every country the address names on its own, where it stands (see countryFromAddress). */
function namedCountries(address: string | null | undefined): NamedCountry[] {
  const text = address?.trim()
  if (!text) return []
  const found: NamedCountry[] = []
  for (const { re, code } of NAME_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const at = match.index ?? 0
      found.push({ at, end: at + match[0].length, code })
    }
  }
  // A US state before its ZIP counts like the country's name, where it stands (1 Ireland Ave, Boston, MA 02110).
  for (const re of [US_STATE_ZIP, US_STATE_NAME_ZIP]) {
    for (const match of text.matchAll(re)) {
      const at = match.index ?? 0
      found.push({ at, end: at + match[0].length, code: 'US' })
    }
  }
  return found.filter(
    (one) => !found.some((other) => other !== one && other.at <= one.at && other.end >= one.end && other.end - other.at > one.end - one.at),
  )
}

/**
 * The country the address names when the VAT number is Swedish and the
 * address is abroad, else null. A business established abroad can register
 * for VAT in Sweden, so its number starts with SE; whether it is established
 * here for the sale (ML 2023:200 16 kap. 4 §) decides whether it owes the
 * VAT or the buyer does (16 kap. 9 §), and the document does not tell. The
 * caller asks the person; nothing decides it as Swedish or as foreign.
 */
export function swedishVatNumberAbroad(identity: SellerIdentity | null | undefined): string | null {
  if (vatNumberCountry(identity?.vatNumber) !== SWEDEN) return null
  return countryEndingAddress(identity?.address)
}

/** What may follow an address's country: a postcode, punctuation, the end. */
const AFTER_COUNTRY = /^[\s\d.,-]*$/

/**
 * The country other than Sweden that ends an address, or null. Stricter than
 * countryFromAddress, since it overrules a Swedish VAT number: the name must
 * close the address (a postcode may follow), so a person or a street called
 * after a country inside a Swedish address ("c/o Israel Andersson",
 * "Danmark 1, 755 91 Uppsala") is no country; an address that names Sweden
 * anywhere is Swedish; and a last part that is only a country's ISO code
 * counts, as a Peppol delivery writes it ("Hauptstr. 1, 10117 Berlin, DE").
 */
function countryEndingAddress(address: string | null | undefined): string | null {
  const text = address?.trim()
  if (!text) return null
  const named = namedCountries(text)
  if (named.some((one) => one.code === SWEDEN)) return null
  if (named.length > 0) {
    const last = named.reduce((latest, one) => (one.at > latest.at ? one : latest))
    if (AFTER_COUNTRY.test(text.slice(last.end))) return last.code
  }
  const isoCode = text.split(/[,\n]/).pop()?.trim().toUpperCase() ?? ''
  return /^[A-Z]{2}$/.test(isoCode) && isoCode !== SWEDEN && isAssignedCountryCode(isoCode) ? isoCode : null
}

const UNKNOWN: SellerCountry = { country: null, region: null, source: null }

/** The seller's country, by the order in the file comment. */
export function sellerCountry(identity: SellerIdentity | null | undefined): SellerCountry {
  if (swedishVatNumberAbroad(identity)) return { ...UNKNOWN }
  const fromVat = vatNumberCountry(identity?.vatNumber)
  if (fromVat) return { country: fromVat, region: regionOfCountry(fromVat), source: 'vat_number' }
  const fromIban = ibanCountry(identity?.iban)
  if (fromIban) return { country: fromIban, region: regionOfCountry(fromIban), source: 'iban' }
  const org = identity?.orgNumber?.replace(/\s/g, '')
  if (org && SWEDISH_ORG_NUMBER.test(org)) return { country: SWEDEN, region: 'se', source: 'org_number' }
  const fromAddress = countryFromAddress(identity?.address)
  if (fromAddress) return { country: fromAddress, region: regionOfCountry(fromAddress), source: 'address' }
  return { ...UNKNOWN }
}

/**
 * Whether an address reads as Swedish: a postnummer printed the Swedish way
 * (three digits, a space, two), an SE- prefix, a Swedish street word, or a
 * letter only Swedish (and its neighbours) prints.
 */
function looksSwedish(address: string): boolean {
  return (
    /\b\d{3} \d{2}\b/.test(address) ||
    /\bSE-?\s?\d{3}\s?\d{2}\b/i.test(address) ||
    /(?:gatan|vägen|väg|torget|gränd|allén|plan|backe)\b/i.test(address) ||
    /[åäöÅÄÖ]/.test(address)
  )
}

/**
 * Whether the document looks like a foreign seller's although no country
 * could be read: it is in a foreign currency, or it prints an address that
 * does not read as Swedish. The caller asks the person then; it never
 * decides the country.
 */
export function looksForeign(input: { currency?: string | null; address?: string | null }): boolean {
  if (!isKronorCurrency(input.currency ?? null)) return true
  const address = input.address?.trim()
  return !!address && !looksSwedish(address)
}
