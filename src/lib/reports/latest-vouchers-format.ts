import type { LatestVoucherPerSeries } from '@/types'

/**
 * Rendering half of the "senaste bokförda verifikat" header line (#1267).
 *
 * Kept dependency-free and separate from `latest-vouchers.ts` so the client
 * report views can import it without dragging the Supabase query path (and
 * through it the logger and observability sink) into the browser bundle.
 */

/**
 * Swedish label for PDF and spreadsheet exports, whose complete document
 * chrome currently renders in Swedish. Client views use the localized
 * `reports.latest_posted_vouchers` message instead.
 *
 * The wording is load-bearing: this is the last POSTED number, not the last
 * number the sequence counter handed out. A reconciler who assumes the other
 * one chases a gap that is not there.
 */
export const LATEST_VOUCHERS_LABEL = 'Senaste bokförda verifikat'

/**
 * Renders the header value, e.g. "A 214, B 37".
 *
 * Returns null when there is nothing to show, so every surface drops the line
 * entirely rather than printing an empty label.
 */
export function formatLatestVouchers(entries: LatestVoucherPerSeries[] | undefined): string | null {
  if (!entries || entries.length === 0) return null
  return entries.map((e) => `${e.series} ${e.last_number}`).join(', ')
}
