import { normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'

/**
 * Legibility key for a voucher description: the identity string an observed
 * party is grouped and displayed by.
 *
 * Built on top of normalizeCounterpartyName() (mirrored in SQL by
 * normalize_counterparty_key) and adds the stages the AP registers of Fortnox,
 * Visma and BL make necessary: "Levfakt BEIJER BYGGMATERIAL AB (2089)" and
 * "Levfakt Beijer Byggmaterial AB, 097" must land on one key,
 * "Leverantörsfaktura från 18 Loopia" on "loopia".
 *
 * Mirrored in SQL by public.ledger_key() (migration 20260902170000) and pinned
 * by tests/pg/observed-parties-rpc.pg.test.ts. Change both or neither.
 *
 * "inköp" is deliberately not a stripped prefix: it turns the generic
 * "inköp av varor" into a vendor-looking "varor" (measured 2026-07-27).
 */
const AP_PREFIX = /^(levfakt|levfkt|leverantörsfaktura från|leverantörsfaktura|levbet|faktura|kvitto|utgift)\s+/
const LEADING_SUPPLIER_NUMBER = /^\d{1,5}\s+/
const TRAILING_SHORT_DIGITS = /(\s+\d{1,3})+$/
const BANK_METHOD = /(kortköp\/uttag|kortkp\/uttag|överföring via internet|bg-bet\.? via internet|pg-bet\.? via internet|bg-bet\.?|autogiro)/gi
const GIRO_REFERENCE = /\b(bg|pg)\s*\d{5,}\b/gi
const CARD_REFERENCE = /\bk\d{3,6}\b/gi
const LONG_DIGITS = /\b\d{6,}\b/g

/**
 * What our own booking flows write: "<counterpart> · <note>", bank method
 * tokens and long references. Keep the head before " · " (or, when the head
 * has no letters, the text after it up to the first comma), drop the tokens.
 * Mirrors the pre-clean in the SQL ledger_key (20260904002000).
 */
export function preClean(raw: string): string {
  let pre = raw
  const sep = pre.indexOf(' · ')
  if (sep >= 0) {
    let head = pre.slice(0, sep)
    if (!/\p{L}/u.test(head)) head = pre.slice(sep + 3).split(',')[0] ?? ''
    pre = head
  }
  return pre.replace(BANK_METHOD, ' ').replace(GIRO_REFERENCE, ' ').replace(CARD_REFERENCE, ' ').replace(LONG_DIGITS, ' ')
}

export function ledgerKey(raw: string | null | undefined): string {
  const k = normalizeCounterpartyName(preClean(raw ?? ''))
  if (!k) return ''
  const stripped = k
    .replace(AP_PREFIX, '')
    .replace(LEADING_SUPPLIER_NUMBER, '')
    .replace(TRAILING_SHORT_DIGITS, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped === '' ? k : stripped
}

const CORE_AP_PREFIX = /^(levfakt|levfkt|lev\.?fakt\.?|leverantörsfaktura från|leverantörsfaktura|levbet\.?|kvitto|faktura|utgift|inköp)\s+/
const CORE_LEGAL_FORM = /\b(ab|aktiebolag|hb|kb|sverige|sweden|ltd|limited|oy|gmbh|inc|sarl|publ|filial)\b/g

/**
 * The "core" of a key: what is left when AP prefixes, digit runs and legal
 * form suffixes are gone. Two keys with one core are the same trade name,
 * which is NOT the same party (Fortnox AB and Fortnox Finans AB share one),
 * so the core only ever ranks or annotates candidates; it never merges.
 * Measured on the document-anchored gold set 2026-09-02: pair precision
 * 0.909, recall 0.776 (scripts/parties/README.md).
 */
export function coreKey(key: string): string {
  return key
    .toLowerCase()
    .replace(CORE_AP_PREFIX, '')
    .replace(/\b\d+\b/g, '')
    .replace(CORE_LEGAL_FORM, '')
    .replace(/[^a-zåäöé ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

const DISPLAY_PREFIX =
  /^(levfakt|levfkt|lev\.?fakt\.?|leverantörsfaktura från\s+\d*|leverantörsfaktura|levbet\.?|kundbet\.?|kundfaktura|kundfakt|inbetalning från|inbetalning|utbetalning till|utbetalning|betalning till|betalning|faktura från|faktura|kvitto|utgift)\s+/i
const DISPLAY_SUFFIX = /(\s*[,(]\s*\d{1,6}\s*\)?|\s+\d{1,4})+$/

/**
 * A display name from raw voucher text: the AP/AR prefix and the supplier
 * number go, the casing and the legal form stay. "Levfakt BEIJER
 * BYGGMATERIAL AB (2089)" reads "BEIJER BYGGMATERIAL AB"; "Kundbet Acme
 * Konsult AB" reads "Acme Konsult AB". Used only when no document carries
 * a printed name; nothing here is generated, only removed.
 */
export function displayNameFromVoucherText(raw: string): string {
  const cleaned = preClean(raw)
    .trim()
    .replace(DISPLAY_PREFIX, '')
    .replace(/^\d{6,10}[,\s]+/, '')
    .replace(DISPLAY_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim()
  return cleaned.length >= 2 ? cleaned : raw.trim()
}

const LEGACY_AP_PREFIX = /^(levfakt|levfkt|leverantörsfaktura från|leverantörsfaktura|levbet|faktura|kvitto|utgift)\s+/
const LEGACY_LEADING_SUPPLIER_NUMBER = /^\d{1,5}\s+/
const LEGACY_TRAILING_SHORT_DIGITS = /(\s+\d{1,3})+$/

/**
 * The ledger key as it was computed before 2026-09-04 (migration
 * 20260904002000): the whole description normalised, with only the AP
 * prefix and short numbers stripped. Parties confirmed under that key keep
 * it as an alias, and the vouchers that produced it now map to the new key,
 * so a rebuild would otherwise offer the same company again as a fresh
 * suggestion. buildSuggestions asks this for every voucher text and attaches
 * the new key to the party that already owns the old one.
 */
export function legacyLedgerKey(raw: string | null | undefined): string {
  const k = normalizeCounterpartyName(raw ?? '')
  if (!k) return ''
  const stripped = k
    .replace(LEGACY_AP_PREFIX, '')
    .replace(LEGACY_LEADING_SUPPLIER_NUMBER, '')
    .replace(LEGACY_TRAILING_SHORT_DIGITS, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped === '' ? k : stripped
}
