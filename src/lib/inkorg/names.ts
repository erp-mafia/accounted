/**
 * A counterpart's name as a person reads it. Banks write names in capitals
 * ("TELIA SVERIGE AB", "MOLNTJANSTEN"); a row title in capitals shouts, so a
 * name with no lower-case letter at all is set in title case, and a name
 * someone already cased ("Kjell & Company", "iZettle") is left alone.
 *
 * Title case keeps what capitals mean: a known vendor keeps its own spelling
 * (IKEA, PayPal, OpenAI), a company form keeps its form (AB, GmbH, Ltd), and a
 * word with a digit (a card token, OKQ8) or of one or two letters (SJ, SL)
 * stays as written. Pure: the bank's own text is still shown as the bank
 * wrote it wherever it is quoted as evidence.
 */
import { VENDOR_KEYS, vendorLook } from '@/lib/vendor-marks'

/** Company forms and the like, lower case -> how they are written. */
const FORMS: Readonly<Record<string, string>> = {
  ab: 'AB',
  hb: 'HB',
  kb: 'KB',
  co: 'Co',
  gmbh: 'GmbH',
  ltd: 'Ltd',
  inc: 'Inc',
  llc: 'LLC',
  plc: 'PLC',
  oy: 'Oy',
  oyj: 'Oyj',
  asa: 'ASA',
  aps: 'ApS',
  bv: 'BV',
  nv: 'NV',
  sas: 'SAS',
}

let vendorWords: Map<string, string> | null = null

/** Every word of every known vendor's own name, lower case -> its spelling there. */
function knownSpellings(): Map<string, string> {
  if (vendorWords) return vendorWords
  vendorWords = new Map()
  for (const key of VENDOR_KEYS) {
    for (const word of vendorLook(key)?.title.split(/\s+/) ?? []) {
      // A vendor written in plain title case teaches nothing title case would not do.
      if (word.length > 2 && word !== titleWord(word)) vendorWords.set(word.toLocaleLowerCase('sv-SE'), word)
    }
  }
  return vendorWords
}

/** "NORD-OST" -> "Nord-Ost", "B&B" -> "B&B": capital first, and after each hyphen or ampersand. */
function titleWord(word: string): string {
  return word
    .toLocaleLowerCase('sv-SE')
    .replace(/(^|[-&])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toLocaleUpperCase('sv-SE'))
}

function readableWord(word: string): string {
  if (/\d/.test(word)) return word
  // Punctuation around a word ("(SVERIGE)", "AB,", "*CHATGPT") stays where it is.
  const m = /^(\P{L}*)(.*?)(\P{L}*)$/u.exec(word)
  const [, lead = '', core = '', trail = ''] = m ?? []
  if (!core) return word
  const lower = core.toLocaleLowerCase('sv-SE')
  const spelled = FORMS[lower] ?? knownSpellings().get(lower)
  if (spelled) return lead + spelled + trail
  if (/^\p{L}{1,2}$/u.test(core)) return word
  return lead + titleWord(core) + trail
}

/** The name with capitals only where they mean something; null and blank stay as they are. */
export function readableName(name: string): string
export function readableName(name: string | null): string | null
export function readableName(name: string | null): string | null {
  if (!name) return name
  // Only a name with letters and no lower-case letter is a bank's capitals.
  if (!/\p{Lu}/u.test(name) || /\p{Ll}/u.test(name)) return name
  return name
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : readableWord(part)))
    .join('')
}
