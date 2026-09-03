/**
 * Customer and supplier country: ISO 3166-1 alpha-2 everywhere.
 *
 * `customers.country` and `suppliers.country` are read as ISO codes by every
 * consumer that cares (periodisk sammanställning / SKV 5740, Peppol BIS
 * Billing, the provider importers, the VAT-treatment rules). Until 2026-09
 * the customer form and the v1 API wrote English names ("Sweden", "Germany")
 * into the same column, which put GERMANY811234567 in the SKV 5740 file and
 * made the report's own EU checks fire on correct data (#2028), and let an EU
 * customer be saved with land Sverige and still get reverse charge (#2025).
 *
 * This module is the single place that knows how to turn what a user, an
 * agent or an old row says into a code, and which code goes with which
 * customer type.
 */
import { EU_COUNTRIES, isEuMemberCountry } from './eu-countries'

export interface CountryOption {
  /** ISO 3166-1 alpha-2 */
  code: string
  /** Swedish name */
  name: string
  /** English name */
  nameEn: string
}

/**
 * Non-EU countries offered in the pickers. Not the whole ISO list: the API
 * accepts any well-formed alpha-2 code, this is only what the form shows.
 */
export const NON_EU_COUNTRIES: CountryOption[] = [
  { code: 'NO', name: 'Norge', nameEn: 'Norway' },
  { code: 'GB', name: 'Storbritannien', nameEn: 'United Kingdom' },
  { code: 'CH', name: 'Schweiz', nameEn: 'Switzerland' },
  { code: 'IS', name: 'Island', nameEn: 'Iceland' },
  { code: 'LI', name: 'Liechtenstein', nameEn: 'Liechtenstein' },
  { code: 'US', name: 'USA', nameEn: 'United States' },
  { code: 'CA', name: 'Kanada', nameEn: 'Canada' },
  { code: 'MX', name: 'Mexiko', nameEn: 'Mexico' },
  { code: 'BR', name: 'Brasilien', nameEn: 'Brazil' },
  { code: 'AU', name: 'Australien', nameEn: 'Australia' },
  { code: 'NZ', name: 'Nya Zeeland', nameEn: 'New Zealand' },
  { code: 'JP', name: 'Japan', nameEn: 'Japan' },
  { code: 'CN', name: 'Kina', nameEn: 'China' },
  { code: 'HK', name: 'Hongkong', nameEn: 'Hong Kong' },
  { code: 'KR', name: 'Sydkorea', nameEn: 'South Korea' },
  { code: 'IN', name: 'Indien', nameEn: 'India' },
  { code: 'SG', name: 'Singapore', nameEn: 'Singapore' },
  { code: 'TH', name: 'Thailand', nameEn: 'Thailand' },
  { code: 'AE', name: 'Förenade Arabemiraten', nameEn: 'United Arab Emirates' },
  { code: 'IL', name: 'Israel', nameEn: 'Israel' },
  { code: 'TR', name: 'Turkiet', nameEn: 'Turkey' },
  { code: 'UA', name: 'Ukraina', nameEn: 'Ukraine' },
  { code: 'RS', name: 'Serbien', nameEn: 'Serbia' },
  { code: 'ZA', name: 'Sydafrika', nameEn: 'South Africa' },
  { code: 'CO', name: 'Colombia', nameEn: 'Colombia' },
  { code: 'CW', name: 'Curaçao', nameEn: 'Curaçao' },
  { code: 'KN', name: 'Saint Kitts och Nevis', nameEn: 'Saint Kitts and Nevis' },
]

/** Every country the pickers offer: the EU 27 first, then the non-EU list. */
export const COUNTRY_OPTIONS: CountryOption[] = [
  ...EU_COUNTRIES.map(({ code, name, nameEn }) => ({ code, name, nameEn })),
  ...NON_EU_COUNTRIES,
]

const OPTION_BY_CODE = new Map(COUNTRY_OPTIONS.map((c) => [c.code, c]))

/**
 * Spellings that are neither an ISO code nor one of the two names above but
 * that real rows and real spreadsheets carry. Keyed by folded name.
 */
const NAME_ALIASES: Record<string, string> = {
  sverige: 'SE',
  sweden: 'SE',
  deutschland: 'DE',
  holland: 'NL',
  'the netherlands': 'NL',
  nederlanderna: 'NL',
  osterrike: 'AT',
  'czech republic': 'CZ',
  czechia: 'CZ',
  tjeckien: 'CZ',
  'republic of ireland': 'IE',
  usa: 'US',
  'united states of america': 'US',
  'u.s.a.': 'US',
  uk: 'GB',
  england: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  'united kingdom of great britain and northern ireland': 'GB',
  norway: 'NO',
  norge: 'NO',
  schweiz: 'CH',
  switzerland: 'CH',
  suisse: 'CH',
  'south korea': 'KR',
  'republic of korea': 'KR',
  'hong kong': 'HK',
  uae: 'AE',
  turkiye: 'TR',
  'türkiye': 'TR',
  'st kitts & nevis': 'KN',
  'st kitts and nevis': 'KN',
  'st. kitts and nevis': 'KN',
  'saint kitts & nevis': 'KN',
}

/** Lowercase, trimmed, single-spaced, without trailing periods. */
function foldName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
}

const NAME_TO_CODE: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const option of COUNTRY_OPTIONS) {
    map.set(foldName(option.name), option.code)
    map.set(foldName(option.nameEn), option.code)
  }
  for (const [alias, code] of Object.entries(NAME_ALIASES)) {
    map.set(foldName(alias), code)
  }
  return map
})()

const ALPHA2_RE = /^[A-Z]{2}$/

/**
 * Every folded name the TypeScript table knows, with its code. Exists so a
 * test can hold the SQL twin in migration 20260903173000 to the same table.
 */
export function listKnownCountryNames(): Array<[name: string, code: string]> {
  return [...NAME_TO_CODE.entries()]
}

/**
 * Turn user, agent or legacy input into an ISO 3166-1 alpha-2 code.
 *
 * Accepts a code in any case ("de", "DE"), the Skatteverket/VIES spelling
 * of Greece ("EL"), the customary "UK", and the Swedish and English names of
 * every country in COUNTRY_OPTIONS plus the aliases above. Returns null for
 * anything else (empty input included): the caller decides whether that is
 * "unknown, keep the raw text" (reports, backfill) or a 400 (API writes).
 *
 * The SQL twin `public.normalize_country_code(text)` (migration
 * 20260903173000) carries the same table for the one-off backfill; keep them
 * in step when adding names here.
 */
export function normalizeCountryCode(input: string | null | undefined): string | null {
  if (input == null) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const upper = trimmed.toUpperCase()
  if (ALPHA2_RE.test(upper)) {
    if (upper === 'EL') return 'GR'
    if (upper === 'UK') return 'GB'
    return upper
  }
  return NAME_TO_CODE.get(foldName(trimmed)) ?? null
}

/** True when the value already is a well-formed uppercase alpha-2 code. */
export function isCountryCode(value: string | null | undefined): boolean {
  return typeof value === 'string' && ALPHA2_RE.test(value)
}

/**
 * Display name for a code in the given locale; the code itself when the
 * country is not in COUNTRY_OPTIONS, and the raw value when it is not a
 * code at all (an unmapped legacy row).
 */
export function getCountryName(code: string | null | undefined, locale: 'sv' | 'en' = 'sv'): string {
  if (!code) return ''
  const normalized = normalizeCountryCode(code)
  const option = normalized ? OPTION_BY_CODE.get(normalized) : undefined
  if (!option) return normalized ?? code
  return locale === 'en' ? option.nameEn : option.name
}

/**
 * COUNTRY_OPTIONS ordered for a picker: Sweden first, the rest by name in
 * the given locale.
 */
export function getCountryOptions(locale: 'sv' | 'en' = 'sv'): CountryOption[] {
  const label = (c: CountryOption) => (locale === 'en' ? c.nameEn : c.name)
  const collator = new Intl.Collator(locale === 'en' ? 'en' : 'sv')
  return [...COUNTRY_OPTIONS].sort((a, b) => {
    if (a.code === 'SE') return -1
    if (b.code === 'SE') return 1
    return collator.compare(label(a), label(b))
  })
}

// ---------------------------------------------------------------------------
// Country vs customer type
// ---------------------------------------------------------------------------

export type CountryPartyType =
  | 'individual'
  | 'swedish_business'
  | 'eu_business'
  | 'non_eu_business'

export type CountryConsistencyIssue =
  | 'SWEDISH_BUSINESS_REQUIRES_SE'
  | 'EU_BUSINESS_COUNTRY_IS_SE'
  | 'EU_BUSINESS_REQUIRES_EU_COUNTRY'
  | 'NON_EU_BUSINESS_REQUIRES_NON_EU_COUNTRY'
  | 'VAT_PREFIX_COUNTRY_MISMATCH'

export const COUNTRY_CONSISTENCY_MESSAGES: Record<
  CountryConsistencyIssue,
  { sv: string; en: string }
> = {
  SWEDISH_BUSINESS_REQUIRES_SE: {
    sv: 'Ett svenskt företag måste ha landet Sverige. Välj kundtypen EU-företag eller Företag utanför EU för en utländsk kund.',
    en: 'A Swedish business must have country SE. Choose EU business or Non-EU business for a foreign customer.',
  },
  EU_BUSINESS_COUNTRY_IS_SE: {
    sv: 'Ett EU-företag kan inte ha landet Sverige. Välj kundens land, eller kundtypen Svenskt företag om kunden är svensk.',
    en: 'An EU business cannot have country SE. Pick the customer\'s country, or choose Swedish business if the customer is Swedish.',
  },
  EU_BUSINESS_REQUIRES_EU_COUNTRY: {
    sv: 'Ett EU-företag måste ha ett land inom EU, eller ett VAT-nummer registrerat i ett annat EU-land. Välj annars kundtypen Företag utanför EU.',
    en: 'An EU business must have an EU country, or a VAT number registered in another EU country. Otherwise choose Non-EU business.',
  },
  NON_EU_BUSINESS_REQUIRES_NON_EU_COUNTRY: {
    sv: 'Ett företag utanför EU kan inte ha ett EU-land. Välj kundtypen EU-företag, eller Svenskt företag för Sverige.',
    en: 'A non-EU business cannot have an EU country. Choose EU business, or Swedish business for Sweden.',
  },
  VAT_PREFIX_COUNTRY_MISMATCH: {
    sv: 'VAT-numrets landsprefix stämmer inte med kundens land.',
    en: 'The VAT number\'s country prefix does not match the customer\'s country.',
  },
}

/**
 * VIES prefixes that name an EU VAT registration: the 27 members (EL for
 * Greece) plus XI, Northern Ireland, which stays in the EU goods VAT area
 * under the Protocol and appears with that prefix in VIES and SKV 5740.
 */
const EU_TRADE_VAT_PREFIXES = new Set([...EU_COUNTRIES.map((c) => c.vatPrefix), 'XI'])

/**
 * Territories inside another member's VAT area: a customer there carries
 * that member's prefix (Monaco is French for VAT, Article 7 of the VAT
 * Directive) and is an EU customer for reverse charge and SKV 5740.
 */
const VAT_TERRITORY_OF: Record<string, string> = { MC: 'FR' }

/** The VIES/Skatteverket prefix for an ISO code (Greece is EL, Monaco is FR). */
export function vatPrefixForCountry(code: string): string {
  const member = VAT_TERRITORY_OF[code] ?? code
  return member === 'GR' ? 'EL' : member
}

/** True when the prefix names a VAT registration in an EU country other than Sweden. */
export function isEuTradeVatPrefix(prefix: string | null | undefined): boolean {
  return !!prefix && prefix !== 'SE' && EU_TRADE_VAT_PREFIXES.has(prefix)
}

/** True when the country is in the EU VAT area: a member, or a territory of one. */
export function isEuVatAreaCountry(code: string): boolean {
  return isEuMemberCountry(code) || code in VAT_TERRITORY_OF
}

/**
 * The two-letter prefix a VAT number starts with, when it starts with one.
 * Whitespace and dots are ignored; "811234567" (no prefix) gives null.
 */
export function vatNumberCountryPrefix(vatNumber: string | null | undefined): string | null {
  if (!vatNumber) return null
  const cleaned = vatNumber.replace(/[\s.\-]/g, '').toUpperCase()
  const match = cleaned.match(/^([A-Z]{2})/)
  return match ? match[1] : null
}

/**
 * The country a NEW row gets when the caller did not supply one.
 *
 * Swedish business and individual: SE (the column default). EU business: the
 * country the VAT number's prefix names, when it names an EU member other
 * than Sweden; without a usable prefix there is nothing to derive from and
 * the caller has to say. Non-EU business: always the caller's to say. Null
 * means "required, not supplied".
 */
export function defaultCountryForParty(
  partyType: string,
  vatNumber?: string | null,
): string | null {
  if (partyType === 'eu_business') {
    const prefix = vatNumberCountryPrefix(vatNumber)
    if (!prefix) return null
    const code = prefix === 'EL' ? 'GR' : prefix
    return code !== 'SE' && isEuMemberCountry(code) ? code : null
  }
  if (partyType === 'non_eu_business') return null
  return 'SE'
}

/**
 * Does the country agree with the party type (and the VAT number's prefix)?
 *
 * - swedish_business: country must be SE.
 * - eu_business: country must not be SE. Inside the EU VAT area (a member,
 *   or Monaco) a VAT number that carries a prefix must carry that country's
 *   prefix. Outside it the customer counts as EU only through an EU VAT
 *   registration: a Swiss company registered in Germany, or Northern
 *   Ireland with its XI prefix.
 * - non_eu_business: country must not be an EU member (SE included).
 * - individual: no rule. A private person abroad is still a customer taxed
 *   with Swedish VAT (or OSS), so the country is free.
 *
 * A country that is missing or not recognisable as a code gives null: there
 * is nothing to compare. Callers that require a code check that first.
 */
export function checkCountryConsistency(input: {
  partyType: string
  country: string | null | undefined
  vatNumber?: string | null
}): CountryConsistencyIssue | null {
  const code = normalizeCountryCode(input.country)
  if (!code) return null

  switch (input.partyType) {
    case 'swedish_business':
      return code === 'SE' ? null : 'SWEDISH_BUSINESS_REQUIRES_SE'

    case 'eu_business': {
      if (code === 'SE') return 'EU_BUSINESS_COUNTRY_IS_SE'
      const prefix = vatNumberCountryPrefix(input.vatNumber)
      if (isEuVatAreaCountry(code)) {
        if (prefix && prefix !== vatPrefixForCountry(code)) return 'VAT_PREFIX_COUNTRY_MISMATCH'
        return null
      }
      return isEuTradeVatPrefix(prefix) ? null : 'EU_BUSINESS_REQUIRES_EU_COUNTRY'
    }

    case 'non_eu_business':
      return isEuMemberCountry(code) ? 'NON_EU_BUSINESS_REQUIRES_NON_EU_COUNTRY' : null

    default:
      return null
  }
}

/**
 * Does this country allow the reverse-charge (0%, ruta 39) treatment an
 * EU-business customer with a validated VAT number gets?
 *
 * Only Sweden refuses it: a buyer established here owes Swedish VAT
 * whatever foreign number it also holds (#2025). Any other country keeps
 * it, because the VIES-validated number is the stronger evidence of an EU
 * registration than the address (a Swiss company registered in Germany,
 * Monaco with a French number, Northern Ireland with XI). An unknown or
 * unmapped country (null, or legacy text that is not a code) does not block
 * either: refusing reverse charge on a genuine German customer whose row
 * still says "Deutschland" would put Swedish VAT on a correct invoice, which
 * is the worse error. The consistency check above stops new contradictory
 * rows from being saved, and migration 20260903173000 repairs the old ones
 * whose country was only ever the writer default.
 */
export function countryPermitsReverseCharge(country: string | null | undefined): boolean {
  return normalizeCountryCode(country) !== 'SE'
}
