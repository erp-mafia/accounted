/**
 * Counterpart resolver, step one: the deterministic pre-pass.
 *
 * Everything a parser can settle is settled here, before the directory and
 * long before a model reads anything. The 200-string reading on 2026-09-08
 * showed where a model goes wrong without this: it picked the payer out of a
 * Bankgiro payment-file line, read a card suffix "K9263" as Klarna, and named
 * a salary line as a person. Each of those is a format, and formats want
 * parsers. What comes out is the text a reader should see (rail split off,
 * method words and card suffixes gone, mojibake repaired), the stable alias
 * key the mapping engine already uses, and every anchor the string carries:
 * a giro number, a domain, a legal-form name, a VAT number, a country.
 */
import { normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { hasMojibakeSignature, reverseMojibake } from '@/lib/bookkeeping/charset-repair'
import { classifyKey, type PartyLabel } from '@/lib/parties/classify'
import { extractNameCandidates, extractVatNumbers } from '@/lib/parties/name-extract'

export interface Precleaned {
  raw: string
  /** What a reader should see: repaired, rail and noise removed, trimmed. */
  text: string
  /** Bank-side identity of the string; the counterparty-template key. */
  aliasKey: string
  label: PartyLabel
  /** Payment facilitator when the string is FACILITATOR*SUBMERCHANT. */
  rail: string | null
  /** The sub-merchant part of such a string, as written. */
  subMerchant: string | null
  giro: { scheme: 'bg' | 'pg'; value: string } | null
  domain: string | null
  /** Payee read out of a Bankgiro/LB payment-file line. */
  lbPayee: string | null
  /** A company named with its legal form in the text. */
  legalName: { name: string; legalForm?: string; country?: string } | null
  vatNumber: string | null
  /** ISO 3166-1 alpha-2 written in the memo (",STOCKHOLM,SE Kortköp"). */
  country: string | null
}

// ── Charset ─────────────────────────────────────────────────────────────

// ISO 646-SE: the seven-bit Swedish set older bank feeds still emit, where
// the brace and bracket code points carry å ä ö. Only applied when the text
// has braces and no proper Swedish letters, so JSON-ish strings stay intact.
const ISO646_SE: Record<string, string> = { '{': 'ä', '}': 'å', '|': 'ö', '[': 'Ä', ']': 'Å', '\\': 'Ö', '¦': 'ö' }

export function repairCharset(raw: string): string {
  let s = raw
  if (hasMojibakeSignature(s)) s = reverseMojibake(s) ?? s
  if (/[{}|[\]\\¦]/.test(s) && !/[åäöÅÄÖ]/.test(s)) s = s.replace(/[{}|[\]\\¦]/g, (c) => ISO646_SE[c] ?? c)
  return s
}

// ── Bankgiro / LB payment-file lines ────────────────────────────────────

// "2617264 DBT.VIEWLEDGER AB 144 240 2617264 350 Brorsan AB c/o ..." and
// "240 DBT.5050-1055 SKATTEVERK 144 240 1655958320228 350 Polytop AB ...".
// DBT. opens the payee (optionally its giro number first); the numbered
// fields 144, 240 and 350 open reference, amount and payer blocks. The payee
// is often cut at twelve characters, so it is a fragment, not a name.
const LB_LINE = /\bDBT\.\s*(\d{3,4}-\d{4}|\d{7,10})?\s*([^\n]*?)\s+(?:144|240|350|Fnr)\b/i

export function parseLbLine(text: string): { payee: string; giro: { scheme: 'bg'; value: string } | null } | null {
  const m = LB_LINE.exec(text)
  if (!m) return null
  const payee = (m[2] ?? '').replace(/\s+/g, ' ').trim()
  if (!payee) return null
  const giroRaw = m[1] ?? null
  const giro = giroRaw && giroRaw.includes('-') ? { scheme: 'bg' as const, value: giroRaw } : null
  return { payee, giro }
}

// ── Payment rails ───────────────────────────────────────────────────────

// Visa's descriptor standard for facilitators is FACILITATOR*SUBMERCHANT.
// The rail is who the bank saw; the sub-merchant is who the money reached.
const RAILS: Array<{ re: RegExp; rail: string }> = [
  { re: /^PAYPAL\s*\*\s*(.+)$/i, rail: 'PayPal' },
  { re: /^PP\s*\*\s*(.+)$/i, rail: 'PayPal' },
  { re: /^KLARNA\s*\*\s*(.+)$/i, rail: 'Klarna' },
  { re: /^K\s*\*\s*(.+)$/, rail: 'Klarna' },
  { re: /^SP\s+([A-ZÅÄÖ][^\n]+)$/, rail: 'Shopify Payments' },
  { re: /^PADDLE\.NET\s*\*\s*(.+)$/i, rail: 'Paddle' },
  { re: /^FSP\s*\*\s*(.+)$/i, rail: 'FastSpring' },
  { re: /^GOOGLE\s*\*\s*(.+)$/i, rail: 'Google Play' },
  { re: /^SQ\s*\*\s*(.+)$/i, rail: 'Square' },
  { re: /^TST\s*\*\s*(.+)$/i, rail: 'Toast' },
  { re: /^(?:IZ|ZETTLE)[\s*_]*(.+)$/i, rail: 'Zettle' },
  { re: /^SUMUP\s*\*\s*(.+)$/i, rail: 'SumUp' },
  { re: /^NYX\s*\*\s*(.+)$/i, rail: 'Svenska Betalsystem' },
  // Accounted's own Stripe descriptions: the payment names the payer.
  { re: /^Stripe-betalning\s+(.+)$/i, rail: 'Stripe' },
]

// Strings where the star part is a reference, not a sub-merchant: the
// facilitator is the counterpart.
const RAIL_IS_COUNTERPART = [
  { re: /^FACEBK\s*\*/i, name: 'Meta' },
  { re: /^AMZN\s*MKTP|^AMAZONMKTPLC|^AmazonMktplc/i, name: 'Amazon' },
  { re: /^APPLE\.COM\/BILL/i, name: 'Apple' },
  { re: /^BKG\s*\*?\s*BOOKING\.COM|^BKG\s+HOTEL\s+AT\s+BOOKING/i, name: 'Booking.com' },
  // Stripe's own fees, refunds and settlement lines.
  { re: /^Stripe-avgift|^Stripe-återbetalning|^Stripe:\s/i, name: 'Stripe' },
]

export function splitRail(text: string): { rail: string | null; subMerchant: string | null; railCounterpart: string | null } {
  for (const c of RAIL_IS_COUNTERPART) if (c.re.test(text)) return { rail: null, subMerchant: null, railCounterpart: c.name }
  for (const r of RAILS) {
    const m = r.re.exec(text)
    if (m?.[1]) {
      const sub = m[1].trim()
      // A bare reference after the star ("SHOPIFY* 54983") names nothing.
      if (/^[\d\s-]+$/.test(sub)) return { rail: r.rail, subMerchant: null, railCounterpart: null }
      return { rail: r.rail, subMerchant: sub, railCounterpart: null }
    }
  }
  return { rail: null, subMerchant: null, railCounterpart: null }
}

// ── Noise ───────────────────────────────────────────────────────────────

const METHOD_WORDS = /\b(?:kortköp\/uttag|kortköp|kortkop|kortkp|uttag|överföring via internet|bg-bet\. via internet|pg-bet\. via internet|bg-bet|pg-bet|via internet|autogiro|swish skickad|swish|card transaction of [\d.,]+ [A-Z]{3} issued by)\b/gi
const CARD_SUFFIX = /\bK\d{4}\b:?/g
const LEADING_DATE = /^(?:kortköp|kortkop)?\s*\d{6}\s+/i
const DATE_FRAGMENT = /\/?\b\d{2}-\d{2}-\d{2}\b/g
const CARD_NUMBER = /\b\d{4}\s\d{2}XX\sXXXX\s\d{4}\b/g
const PURCHASE_DATE = /\bPurchase Date\b.*$/i
const WISE_CARD_PREFIX = /^(?:FEE-)?CARD-\d+\s*/i
const TRAILING_REF = /\s+(?:\d{5,}|[A-Z]\d{6,}|[A-Z0-9]{8,})$/
// ",SAN FRANCISCO,US", ",4029357733,US" and ",US": the memo's location tail.
const CITY_COUNTRY = /,\s*(?:[A-ZÅÄÖa-zåäö][A-ZÅÄÖa-zåäö .'-]{1,30}|[\d+\s-]{5,}),\s*([A-Z]{2})\s*$/
const COUNTRY_ONLY = /,\s*([A-Z]{2})\s*$/
const TRAILING_DIGIT_SEGMENT = /,\s*[\d+\s-]{5,}\s*$/
const PUNCT_EDGES = /^[\s,:;.*-]+|[\s,:;.*-]+$/g

export function stripNoise(text: string): { text: string; country: string | null } {
  let s = text.replace(WISE_CARD_PREFIX, '').replace(LEADING_DATE, '')
  let country: string | null = null
  s = s.replace(METHOD_WORDS, ' ').replace(CARD_SUFFIX, ' ').replace(CARD_NUMBER, ' ').replace(PURCHASE_DATE, ' ').replace(DATE_FRAGMENT, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  const cc = CITY_COUNTRY.exec(s) ?? COUNTRY_ONLY.exec(s)
  if (cc) {
    country = cc[1]!
    s = s.slice(0, cc.index)
  }
  s = s.replace(TRAILING_DIGIT_SEGMENT, '')
  s = s.replace(TRAILING_REF, '').replace(PUNCT_EDGES, '').replace(/\s+/g, ' ').trim()
  return { text: s, country }
}

// ── Anchors ─────────────────────────────────────────────────────────────

const DOMAIN = /\b((?:[a-z0-9-]+\.)+(?:com|se|io|net|org|co|ai|app|dev|eu|nl|de|uk|dk|no|fi|us|shop|store|me|tv|info))\b(?:\/[a-z0-9]*)?/i
const GIRO_IN_TEXT = /\b(BG|PG)\s*0*(\d{3,4})-?(\d{4})\b/i

export function extractDomain(text: string): string | null {
  const m = DOMAIN.exec(text)
  if (!m) return null
  const host = m[1]!.toLowerCase().replace(/^www\./, '')
  // "apple.combill" is a broken "apple.com/bill"; keep the host part only.
  return host
}

export function extractGiro(text: string): { scheme: 'bg' | 'pg'; value: string } | null {
  const m = GIRO_IN_TEXT.exec(text)
  if (!m) return null
  return { scheme: m[1]!.toLowerCase() as 'bg' | 'pg', value: `${m[2]}-${m[3]}` }
}

// ── The pass ────────────────────────────────────────────────────────────

export function preclean(raw: string): Precleaned {
  const repaired = repairCharset(raw.trim())
  const lb = parseLbLine(repaired)
  const afterLb = lb ? lb.payee : repaired
  const { rail, subMerchant, railCounterpart } = splitRail(afterLb)
  const forNoise = railCounterpart ?? subMerchant ?? afterLb
  const { text: stripped, country } = stripNoise(forNoise)
  const text = stripped || forNoise.trim() || repaired
  const aliasKey = normalizeCounterpartyName(raw) || raw.trim().toLowerCase()
  const label = classifyKey({ key: aliasKey })
  const legal = extractNameCandidates(text).find((c) => c.source === 'legal_form' || c.source === 'country') ?? null
  const vat = extractVatNumbers(repaired)[0] ?? null
  return {
    raw,
    text,
    aliasKey,
    label,
    rail,
    subMerchant,
    giro: lb?.giro ?? extractGiro(repaired),
    domain: extractDomain(repaired),
    lbPayee: lb?.payee ?? null,
    legalName: legal ? { name: legal.name, legalForm: legal.legalForm, country: legal.country } : null,
    vatNumber: vat?.vat ?? null,
    country: country ?? legal?.country ?? (vat ? vat.country : null),
  }
}
