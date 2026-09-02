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
