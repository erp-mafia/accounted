/**
 * Parties: which company a voucher text is talking about.
 *
 * Descriptions written by people and by the assistant carry the counterpart
 * somewhere inside a sentence: "1511768101 · Visma Spcs AB, faktura
 * 2025-10-02", "TIC identity BG 0000005786439 Bg-bet. via internet · Faktura
 * 20250746, The Intelligence Company AB (publ)", "Utlägg Framer · Framer B.V.
 * (NL), webbdesignverktyg". The ledger key groups such vouchers; this module
 * names them. It anchors on legal-form words (AB, Inc., B.V., GmbH, Oy, ...)
 * and on country words, and reads EU VAT numbers out of the text. Nothing is
 * generated: every candidate is a substring of the text, returned in the
 * order worth trying against a register. A foreign legal form or country
 * means SCB's register cannot hold the company, so the caller can say so
 * instead of searching in vain.
 */
import { displayNameFromVoucherText } from './ledger-key'

export interface NameCandidate {
  /** The name as written, with its legal form when there is one. */
  name: string
  /** Canonical legal form, e.g. 'AB', 'B.V.', 'Inc.'. */
  legalForm?: string
  /** ISO 3166-1 alpha-2 when the form or the text says so. */
  country?: string
  /** Not a Swedish legal person: SCB's register cannot hold it. */
  foreign: boolean
  source: 'legal_form' | 'country' | 'head'
}

export interface VatNumberHit {
  vat: string
  country: string
}

interface FormSpec {
  pattern: string
  canonical: string
  foreign: boolean
  country?: string
  /** Short uppercase tokens are matched as written; words are not. */
  caseSensitive: boolean
}

// Order matters where one form contains another (Pte. Ltd. before Ltd,
// Oyj before Oy, ASA before AS, AB (publ) before AB).
const FORMS: FormSpec[] = [
  { pattern: 'AB\\s*\\(publ\\)', canonical: 'AB (publ)', foreign: false, caseSensitive: true },
  { pattern: 'Aktiebolag(?:et)?', canonical: 'AB', foreign: false, caseSensitive: false },
  { pattern: 'AB', canonical: 'AB', foreign: false, caseSensitive: true },
  { pattern: 'HB', canonical: 'HB', foreign: false, caseSensitive: true },
  { pattern: 'KB', canonical: 'KB', foreign: false, caseSensitive: true },
  { pattern: 'ekonomisk förening', canonical: 'ek. för.', foreign: false, caseSensitive: false },
  { pattern: 'ek\\.?\\s*för\\.?', canonical: 'ek. för.', foreign: false, caseSensitive: false },
  { pattern: 'Pte\\.?\\s*Ltd\\.?', canonical: 'Pte. Ltd.', foreign: true, country: 'SG', caseSensitive: false },
  { pattern: 'Pty\\.?\\s*Ltd\\.?', canonical: 'Pty Ltd', foreign: true, country: 'AU', caseSensitive: false },
  { pattern: 'Inc\\.?', canonical: 'Inc.', foreign: true, country: 'US', caseSensitive: true },
  { pattern: 'Incorporated', canonical: 'Inc.', foreign: true, country: 'US', caseSensitive: false },
  { pattern: 'Corp\\.?', canonical: 'Corp.', foreign: true, country: 'US', caseSensitive: true },
  { pattern: 'Corporation', canonical: 'Corp.', foreign: true, country: 'US', caseSensitive: false },
  { pattern: 'LLC|L\\.L\\.C\\.', canonical: 'LLC', foreign: true, country: 'US', caseSensitive: true },
  { pattern: 'PBC', canonical: 'PBC', foreign: true, country: 'US', caseSensitive: true },
  { pattern: 'Ltd\\.?', canonical: 'Ltd', foreign: true, caseSensitive: true },
  { pattern: 'Limited', canonical: 'Ltd', foreign: true, caseSensitive: false },
  { pattern: 'PLC|plc', canonical: 'PLC', foreign: true, country: 'GB', caseSensitive: true },
  { pattern: 'LLP', canonical: 'LLP', foreign: true, caseSensitive: true },
  { pattern: 'GmbH(?:\\s*&\\s*Co\\.?\\s*KG)?', canonical: 'GmbH', foreign: true, country: 'DE', caseSensitive: true },
  { pattern: 'e\\.V\\.', canonical: 'e.V.', foreign: true, country: 'DE', caseSensitive: true },
  { pattern: 'AG', canonical: 'AG', foreign: true, caseSensitive: true },
  { pattern: 'B\\.V\\.|BV', canonical: 'B.V.', foreign: true, country: 'NL', caseSensitive: true },
  { pattern: 'N\\.V\\.|NV', canonical: 'N.V.', foreign: true, country: 'NL', caseSensitive: true },
  { pattern: 'Oyj', canonical: 'Oyj', foreign: true, country: 'FI', caseSensitive: true },
  { pattern: 'Oy', canonical: 'Oy', foreign: true, country: 'FI', caseSensitive: true },
  { pattern: 'ApS', canonical: 'ApS', foreign: true, country: 'DK', caseSensitive: true },
  { pattern: 'A/S', canonical: 'A/S', foreign: true, country: 'DK', caseSensitive: true },
  { pattern: 'ASA', canonical: 'ASA', foreign: true, country: 'NO', caseSensitive: true },
  { pattern: 'AS', canonical: 'AS', foreign: true, caseSensitive: true },
  { pattern: 'S\\.A\\.S\\.|SAS', canonical: 'SAS', foreign: true, country: 'FR', caseSensitive: true },
  { pattern: 'SARL|S\\.à\\.?\\s?r\\.l\\.|Sàrl|Sarl', canonical: 'SARL', foreign: true, caseSensitive: true },
  { pattern: 'S\\.A\\.', canonical: 'S.A.', foreign: true, caseSensitive: true },
  { pattern: 'S\\.L\\.', canonical: 'S.L.', foreign: true, country: 'ES', caseSensitive: true },
  { pattern: 'S\\.r\\.l\\.|Srl', canonical: 'S.r.l.', foreign: true, country: 'IT', caseSensitive: true },
  { pattern: 'S\\.p\\.A\\.|SpA', canonical: 'S.p.A.', foreign: true, country: 'IT', caseSensitive: true },
  { pattern: 'Kft\\.?', canonical: 'Kft.', foreign: true, country: 'HU', caseSensitive: true },
  { pattern: 'Zrt\\.?', canonical: 'Zrt.', foreign: true, country: 'HU', caseSensitive: true },
  { pattern: 'Sp\\.?\\s*z\\s*o\\.?\\s*o\\.?', canonical: 'Sp. z o.o.', foreign: true, country: 'PL', caseSensitive: false },
  { pattern: 'UAB', canonical: 'UAB', foreign: true, country: 'LT', caseSensitive: true },
  { pattern: 'OÜ', canonical: 'OÜ', foreign: true, country: 'EE', caseSensitive: true },
  { pattern: 'SIA', canonical: 'SIA', foreign: true, country: 'LV', caseSensitive: true },
  { pattern: 's\\.r\\.o\\.', canonical: 's.r.o.', foreign: true, caseSensitive: false },
  { pattern: 'd\\.o\\.o\\.', canonical: 'd.o.o.', foreign: true, caseSensitive: false },
  { pattern: 'Lda\\.?', canonical: 'Lda', foreign: true, country: 'PT', caseSensitive: true },
]

const FORM_REGEXES = FORMS.map((f) => ({
  spec: f,
  re: new RegExp(`(?:^|[\\s(])(${f.pattern})(?=$|[\\s.,;:)])`, f.caseSensitive ? 'u' : 'iu'),
}))

// Country words as they appear in voucher text, Swedish and English.
const COUNTRY_WORDS: Array<[RegExp, string]> = [
  [/\b(?:Sverige|Sweden)\b/iu, 'SE'],
  [/\b(?:Ireland|Irland)\b/iu, 'IE'],
  [/\b(?:USA|U\.S\.A\.|United States)\b/iu, 'US'],
  [/\b(?:UK|U\.K\.|United Kingdom|Storbritannien|England)\b/u, 'GB'],
  [/\b(?:Nederländerna|Netherlands|Holland)\b/iu, 'NL'],
  [/\b(?:Cypern|Cyprus)\b/iu, 'CY'],
  [/\b(?:Tyskland|Germany|Deutschland)\b/iu, 'DE'],
  [/\b(?:Finland)\b/iu, 'FI'],
  [/\b(?:Danmark|Denmark)\b/iu, 'DK'],
  [/\b(?:Norge|Norway)\b/iu, 'NO'],
  [/\b(?:Frankrike|France)\b/iu, 'FR'],
  [/\b(?:Spanien|Spain)\b/iu, 'ES'],
  [/\b(?:Italien|Italy)\b/iu, 'IT'],
  [/\b(?:Singapore)\b/iu, 'SG'],
  [/\b(?:Estland|Estonia)\b/iu, 'EE'],
  [/\b(?:Lettland|Latvia)\b/iu, 'LV'],
  [/\b(?:Litauen|Lithuania)\b/iu, 'LT'],
  [/\b(?:Polen|Poland)\b/iu, 'PL'],
  [/\b(?:Schweiz|Switzerland)\b/iu, 'CH'],
  [/\b(?:Österrike|Austria)\b/iu, 'AT'],
  [/\b(?:Belgien|Belgium)\b/iu, 'BE'],
  [/\b(?:Luxemburg|Luxembourg)\b/iu, 'LU'],
  [/\b(?:Portugal)\b/iu, 'PT'],
  [/\b(?:Tjeckien|Czechia|Czech Republic)\b/iu, 'CZ'],
  [/\b(?:Ungern|Hungary)\b/iu, 'HU'],
  [/\b(?:Kanada|Canada)\b/iu, 'CA'],
  [/\b(?:Australien|Australia)\b/iu, 'AU'],
  [/\b(?:Indien|India)\b/iu, 'IN'],
  [/\b(?:Kina|China)\b/iu, 'CN'],
  [/\b(?:Japan)\b/iu, 'JP'],
]

// Two- or three-letter codes only inside parentheses: "(NL)", "(USA)".
const CODE_IN_PARENS = /\((?:[^()]*?,\s*)?([A-Z]{2,3})\)/u
const CODE_MAP: Record<string, string> = {
  USA: 'US', US: 'US', UK: 'GB', GB: 'GB', IE: 'IE', NL: 'NL', CY: 'CY', DE: 'DE', FI: 'FI', DK: 'DK', NO: 'NO',
  FR: 'FR', ES: 'ES', IT: 'IT', SG: 'SG', EE: 'EE', LV: 'LV', LT: 'LT', PL: 'PL', CH: 'CH', AT: 'AT', BE: 'BE',
  LU: 'LU', PT: 'PT', CZ: 'CZ', HU: 'HU', CA: 'CA', AU: 'AU', IN: 'IN', CN: 'CN', JP: 'JP', SE: 'SE',
}

// Words that precede a name without being part of it.
const LEAD_WORDS = new Set([
  'utlägg', 'faktura', 'fakturor', 'leverantörsfaktura', 'levfakt', 'levfkt', 'kundfaktura', 'kvitto', 'betalning',
  'kundbet', 'kundbetalning', 'kundinbetalning', 'levbet', 'leverantörsbetalning', 'utbet', 'inbet', 'betalt', 'betald',
  'delbetalning', 'delbet', 'inbetalning', 'utbetalning', 'till', 'från', 'av', 'för', 'hos', 'via', 'och', 'rättelse',
  'ankomst', 'ref', 'inköp', 'köp', 'abonnemang', 'prenumeration', 'månadsavgift', 'avgift', 'konsult', 'tjänst',
  'kortköp/uttag', 'kortköp', 'uttag', 'överföring', 'internet', 'bg-bet.', 'bg-bet', 'pg-bet.', 'autogiro',
])

const VAT_RE = /\b(AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|EL|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE|GB|XI)\s?([0-9A-Z]{8,12})\b/gu

function stripVatSweden(text: string): string {
  // "VAT-Sweden 25%" is a tax line on foreign invoices, not a country.
  return text.replace(/VAT\s?-?\s?Sweden/giu, ' ')
}

function countryHint(text: string): string | undefined {
  const cleaned = stripVatSweden(text)
  const code = CODE_IN_PARENS.exec(cleaned)?.[1]
  if (code && CODE_MAP[code]) return CODE_MAP[code]
  for (const [re, country] of COUNTRY_WORDS) if (re.test(cleaned)) return country
  return undefined
}

/** EU-style VAT numbers written in the text, deduplicated, SE included. */
export function extractVatNumbers(text: string): VatNumberHit[] {
  const out = new Map<string, VatNumberHit>()
  for (const m of text.matchAll(VAT_RE)) {
    const body = m[2]!
    if ((body.match(/\d/g) ?? []).length < 7) continue
    const vat = `${m[1]}${body}`
    if (!out.has(vat)) out.set(vat, { vat, country: m[1]! })
  }
  return [...out.values()]
}

function splitSegments(text: string): string[] {
  return text
    .split(/\s*(?:·|,|;|:|\||\n|\s[-–—]\s)\s*/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

function nameTokensBefore(before: string): string[] {
  let tokens = before.trim().split(/\s+/u).filter(Boolean)
  // A parenthesis closes whatever came before it: "(ankomst 2) Acme".
  const lastParen = tokens.map((t) => t.includes(')')).lastIndexOf(true)
  if (lastParen >= 0) tokens = tokens.slice(lastParen + 1)
  while (tokens.length) {
    const t = tokens[0]!
    const bare = t.replace(/^[("'`]+|[)"'`]+$/gu, '')
    if (!/\p{L}/u.test(bare) || LEAD_WORDS.has(bare.toLowerCase()) || /^\d{4}-\d{2}(-\d{2})?$/u.test(bare)) {
      tokens.shift()
      continue
    }
    break
  }
  return tokens.slice(-6).map((t) => t.replace(/^[("'`]+|[)"'`.]+$/gu, ''))
}

function legalFormCandidate(segment: string, next: string | undefined, whole: string): NameCandidate | null {
  let best: { index: number; length: number; spec: FormSpec } | null = null
  for (const { spec, re } of FORM_REGEXES) {
    const m = re.exec(segment)
    if (!m) continue
    const index = m.index + m[0].length - m[1]!.length
    if (!best || index < best.index) best = { index, length: m[1]!.length, spec }
  }
  if (!best) return null
  const tokens = nameTokensBefore(segment.slice(0, best.index))
  if (tokens.length === 0) return null
  const after = `${segment.slice(best.index + best.length)} ${next ?? ''}`
  const country = best.spec.country ?? countryHint(after) ?? countryHint(whole)
  const foreign = best.spec.foreign
  return {
    name: `${tokens.join(' ')} ${best.spec.canonical}`,
    legalForm: best.spec.canonical,
    ...(country ? { country } : {}),
    foreign,
    source: 'legal_form',
  }
}

function countryCandidate(segment: string): NameCandidate | null {
  for (const [re, country] of COUNTRY_WORDS) {
    if (country === 'SE') continue
    const m = re.exec(stripVatSweden(segment))
    if (!m) continue
    const tokens = nameTokensBefore(segment.slice(0, m.index))
    if (tokens.length === 0 || tokens.length > 4) return null
    return { name: `${tokens.join(' ')} ${m[0]}`, country, foreign: true, source: 'country' }
  }
  return null
}

/**
 * Name candidates in the order worth trying: Swedish legal persons first,
 * then names anchored on a country word, then the cleaned head of the text.
 * The head is marked foreign when the text as a whole points abroad.
 */
export function extractNameCandidates(text: string): NameCandidate[] {
  const out: NameCandidate[] = []
  const seen = new Set<string>()
  const push = (c: NameCandidate | null) => {
    if (!c) return
    const k = c.name.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(c)
  }
  const segments = splitSegments(text)
  const forms: NameCandidate[] = []
  const countries: NameCandidate[] = []
  segments.forEach((seg, i) => {
    const f = legalFormCandidate(seg, segments[i + 1], text)
    if (f) forms.push(f)
    else {
      const c = countryCandidate(seg)
      if (c) countries.push(c)
    }
  })
  forms.filter((c) => !c.foreign).forEach(push)
  forms.filter((c) => c.foreign).forEach(push)
  countries.forEach(push)

  const head = displayNameFromVoucherText(text)
  if (head.length >= 2) {
    const textCountry = countryHint(text)
    const foreignVat = extractVatNumbers(text).some((v) => v.country !== 'SE')
    const foreign = out.some((c) => c.foreign) || (textCountry !== undefined && textCountry !== 'SE') || foreignVat
    push({
      name: head,
      ...(textCountry && textCountry !== 'SE' ? { country: textCountry } : {}),
      foreign,
      source: 'head',
    })
  }
  return out
}
