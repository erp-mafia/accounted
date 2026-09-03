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

export function ledgerKey(raw: string | null | undefined): string {
  const k = normalizeCounterpartyName(raw ?? '')
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
  const cleaned = raw.trim().replace(DISPLAY_PREFIX, '').replace(DISPLAY_SUFFIX, '').trim()
  return cleaned.length >= 2 ? cleaned : raw.trim()
}
