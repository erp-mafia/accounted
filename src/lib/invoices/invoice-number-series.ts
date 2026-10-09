/**
 * Keep the company's invoice series ahead of numbers it already used
 * elsewhere.
 *
 * generate_invoice_number hands out invoice_prefix followed by the counter
 * company_settings.next_invoice_number (LPAD to at least three digits). A
 * provider migration imports the old system's invoices with their own
 * numbers but never touched that counter, so the first invoice after the
 * move came out as 001 while the old series stood far higher: a löpnummer
 * that restarts inside one series (ML 17 kap 24 § p. 2, BFL 5 kap 6 §),
 * locked for good once issued.
 *
 * The counter only ever moves forward here, by a conditional update, so a
 * concurrent issue that already took the counter past the imported numbers
 * is never undone, and a company that set a higher start number keeps it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** next_invoice_number is a Postgres integer: one past the highest must still fit. */
const MAX_SERIES_NUMBER = 2_147_483_646

/**
 * The counter value an existing invoice number occupies in the company's own
 * series, or null when it is not in that series. generate_invoice_number
 * writes invoice_prefix followed by digits, so with a prefix only
 * `<prefix><digits>` is in the series; without one, only bare digits.
 * Anything else (a credit-note prefix, a year-dashed number, letters inside,
 * bare digits under a prefixed series) leaves the counter alone.
 */
export function seriesNumberOf(
  invoiceNumber: string | null | undefined,
  invoicePrefix: string | null | undefined,
): number | null {
  const raw = invoiceNumber?.trim()
  if (!raw) return null
  const prefix = invoicePrefix ?? ''
  if (prefix && !raw.startsWith(prefix)) return null
  const digits = raw.slice(prefix.length)
  if (!/^\d+$/.test(digits)) return null
  const n = Number(digits)
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_SERIES_NUMBER ? n : null
}

/** The highest series number among `invoiceNumbers`, or null when none is in the series. */
export function highestSeriesNumber(
  invoiceNumbers: Iterable<string | null | undefined>,
  invoicePrefix: string | null | undefined,
): number | null {
  let highest: number | null = null
  for (const number of invoiceNumbers) {
    const n = seriesNumberOf(number, invoicePrefix)
    if (n !== null && (highest === null || n > highest)) highest = n
  }
  return highest
}

/** A jump larger than this is not a series continuing: never applied automatically. */
export const MAX_SERIES_JUMP = 10_000

/** How many numbers below the highest are checked for a dense series. */
const DENSITY_WINDOW = 20

/**
 * Whether the imported numbers look like a series the counter should
 * continue, or like an outlier it must not jump to: a jump of more than
 * MAX_SERIES_JUMP, or a highest number with fewer than half of the numbers
 * just below it present (one stray order or OCR-like number among a short
 * series). Pure: the caller decides what to do with the verdict.
 */
export function isSeriesOutlier(seriesNumbers: ReadonlySet<number>, highest: number, current: number): boolean {
  if (highest - current > MAX_SERIES_JUMP) return true
  const window = Math.min(DENSITY_WINDOW, highest - 1)
  let present = 0
  for (let n = highest - window; n < highest; n++) if (seriesNumbers.has(n)) present++
  return present * 2 < window
}

export type AdvanceSeriesResult =
  | { advanced: true; from: number; to: number }
  | { advanced: false; reason: 'no_series_numbers' | 'already_ahead' | 'no_settings' }
  /** The imported numbers do not look like a continuing series: nothing changed, the caller logs it. */
  | { advanced: false; reason: 'outlier'; current: number; highest: number }

/**
 * Move next_invoice_number to one past the highest imported number that is
 * in the company's series, when it is not already past it. Never lowers it.
 * Throws when a read or the update fails; the migration callers log and go on,
 * because a settings write must not fail an import that already landed.
 */
export async function advanceInvoiceSeriesPastImported(
  supabase: SupabaseClient,
  companyId: string,
  invoiceNumbers: Iterable<string | null | undefined>,
): Promise<AdvanceSeriesResult> {
  const { data: settings, error } = await supabase
    .from('company_settings')
    .select('invoice_prefix, next_invoice_number')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`invoice series read failed: ${error.message}`)
  if (!settings) return { advanced: false, reason: 'no_settings' }

  const row = settings as { invoice_prefix: string | null; next_invoice_number: number | null }
  const seriesNumbers = new Set<number>()
  let highest = 0
  for (const number of invoiceNumbers) {
    const n = seriesNumberOf(number, row.invoice_prefix)
    if (n === null) continue
    seriesNumbers.add(n)
    if (n > highest) highest = n
  }
  if (seriesNumbers.size === 0) return { advanced: false, reason: 'no_series_numbers' }
  const current = Number(row.next_invoice_number ?? 1)
  if (current > highest) return { advanced: false, reason: 'already_ahead' }
  // A gap in the live series is permanent: never jump to a number that does
  // not look like the end of the imported series. The user sets it by hand.
  if (isSeriesOutlier(seriesNumbers, highest, current)) {
    return { advanced: false, reason: 'outlier', current, highest }
  }

  // Conditional on the counter still being at or below the highest number:
  // an invoice issued between the read and this write already moved it, and
  // this must never move it back. The audit_company_settings trigger records
  // the change.
  const { data: updated, error: updateError } = await supabase
    .from('company_settings')
    .update({ next_invoice_number: highest + 1 })
    .eq('company_id', companyId)
    .lte('next_invoice_number', highest)
    .select('next_invoice_number')
  if (updateError) throw new Error(`invoice series update failed: ${updateError.message}`)
  if (!updated || updated.length === 0) return { advanced: false, reason: 'already_ahead' }
  return { advanced: true, from: current, to: highest + 1 }
}
