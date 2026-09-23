/**
 * Parties: the name a register gives, as the register shows it.
 *
 * Bolagsverket registers many company names in capitals, and SCB returns
 * them that way ("WEBHALLEN SVERIGE AB", "AKTIEBOLAGET VOLVO"). A supplier
 * list full of capitals reads like shouting, so an all-capitals name is set
 * in title case with the legal-form tokens kept as they are written. A name
 * with any lowercase letter is a name someone typed deliberately and is left
 * alone. legal_name and the fact keep the registry's own spelling; only the
 * display name is set this way.
 */

const KEEP_UPPER = new Set(['AB', 'HB', 'KB', 'AS', 'ASA', 'OY', 'OYJ', 'BV', 'NV', 'SA', 'AG', 'LLC', 'PLC', 'KG', 'GMBH', 'USA', 'UK', 'EU', 'IKEA', 'SJ', 'SL', 'SEB', 'ICA', 'SCB', 'KPMG', 'PWC', 'EY', 'BDO', 'ABB', 'SKF', 'SSAB', 'SAS', 'NCC', 'JM', 'HSB', 'LRF', 'ATG'])
const KEEP_LOWER = new Set(['AV', 'OCH', 'I', 'FÖR', 'MED', 'PÅ', 'TILL', 'FRÅN', 'DE', 'DEL', 'VON', 'VAN', 'DER', 'DEN', 'OF', 'THE', 'AND'])

function isAllCaps(s: string): boolean {
  return /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s)
}

function titleWord(word: string, first: boolean): string {
  const upper = word.toUpperCase()
  if (upper === '(PUBL)') return '(publ)'
  if (KEEP_UPPER.has(upper)) return upper === 'GMBH' ? 'GmbH' : upper
  if (!first && KEEP_LOWER.has(upper)) return word.toLowerCase()
  // Hyphenated and apostrophe parts each get a capital: "SVENSK-DANSKA" -> "Svensk-Danska".
  return word.toLowerCase().replace(/(^|[-'’/&(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
}

/** The display form of a registry name: title case when the register wrote it in capitals. */
export function displayNameFromRegistry(legalName: string): string {
  const trimmed = legalName.replace(/\s+/g, ' ').trim()
  if (!trimmed || !isAllCaps(trimmed)) return trimmed
  return trimmed
    .split(' ')
    .map((w, i) => titleWord(w, i === 0))
    .join(' ')
}

/** Same company name, spelling and case aside. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(a) !== '' && norm(a) === norm(b)
}
