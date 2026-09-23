/**
 * The voucher reference a provider attaches to an invoice, as written in the
 * SOURCE system ("A329"). It is the only safe join key back to the verifikat
 * the SIE import created for that booking: the importer renumbers per series
 * but preserves the source pair on `journal_entries.source_voucher_series` /
 * `source_voucher_number` (see lib/documents/voucher-ref-resolver.ts).
 *
 * Providers spell the reference differently: Visma eAccounting puts one
 * string on the invoice (`VoucherNumber`, "A329" or a bare "329"), Fortnox
 * splits it into `VoucherSeries` + `VoucherNumber`. Both normalise to the
 * same shape here. A reference that cannot be read with certainty becomes
 * null rather than a guess: a wrong link attaches an invoice to somebody
 * else's verifikat and is räkenskapsinformation once written.
 */

import type { SourceVoucherRefDto } from './dto'

export type { SourceVoucherRefDto }

/**
 * "A329", "A 329", "A-329", "a329" and a bare "329" all parse; anything else
 * (empty, decimals, prose, a number with no digits) yields null.
 */
const REF_PATTERN = /^(?:([A-Za-zÅÄÖåäö]{1,4})[\s-]*)?(\d{1,9})$/

export function parseSourceVoucherRef(value: unknown): SourceVoucherRefDto | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? { series: null, number: value } : null
  }
  if (typeof value !== 'string') return null

  const match = REF_PATTERN.exec(value.trim())
  if (!match) return null

  const number = Number.parseInt(match[2], 10)
  if (!Number.isFinite(number) || number <= 0) return null

  return { series: match[1] ? match[1].toUpperCase() : null, number }
}

/**
 * The split form (Fortnox): a series string next to a numeric voucher number.
 * The series is optional (some payloads omit it on unbooked invoices); the
 * number is not. A number of 0 means "not booked" in Fortnox and yields null.
 */
export function sourceVoucherFromParts(series: unknown, number: unknown): SourceVoucherRefDto | null {
  const parsedNumber =
    typeof number === 'number'
      ? number
      : typeof number === 'string' && /^\d{1,9}$/.test(number.trim())
        ? Number.parseInt(number.trim(), 10)
        : NaN
  if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) return null

  const parsedSeries =
    typeof series === 'string' && series.trim() ? series.trim().toUpperCase() : null

  return { series: parsedSeries, number: parsedNumber }
}
