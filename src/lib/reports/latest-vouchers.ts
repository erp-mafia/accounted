import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import type { LatestVoucherPerSeries } from '@/types'

interface LatestVoucherRow {
  voucher_series: string
  last_number: number
}

/**
 * Highest POSTED voucher number per series within a reported window.
 *
 * Reads `journal_entries`, never `voucher_sequences`. The sequence table holds
 * an allocation high-water mark that drifts from reality in both directions:
 * `next_voucher_number` burns a number when the follow-up insert fails,
 * `delete_last_voucher` decrements blindly by one rather than resetting to the
 * new MAX, and pre-RPC SIE imports left it behind. Since the whole point of
 * this figure is reconciliation, only a number the user can actually look up in
 * the books is worth printing.
 *
 * The window is bounded below by `fiscalPeriodId` alone when `fromDate` is
 * omitted, which is what an accumulating report (balansrapport) wants.
 *
 * The latest_posted_vouchers SQL function answers it with a few index probes:
 * posted and reversed entries count (a stornerad verifikat keeps its number
 * and its slot in the series, so leaving it out would report a gap that does
 * not exist), drafts and cancelled entries carry voucher_number 0 and do not,
 * and an empty series counts as A. Paging every verifikat of the period here
 * cost one round trip per 1 000 verifikat.
 */
export async function getLatestPostedVouchers(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  window: { fromDate?: string; toDate: string }
): Promise<LatestVoucherPerSeries[]> {
  const { data, error } = await supabase.rpc('latest_posted_vouchers', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_from_date: window.fromDate ?? null,
    p_to_date: window.toDate,
  })
  if (error) throw dbError(error, 'latest_posted_vouchers failed')

  return ((data ?? []) as LatestVoucherRow[])
    .map((row) => ({ series: row.voucher_series, last_number: Number(row.last_number) }))
    .sort((a, b) => a.series.localeCompare(b.series, 'sv'))
}

// Re-exported for convenience on server surfaces; the canonical home is the
// dependency-free format module, which client components import directly.
export { formatLatestVouchers, LATEST_VOUCHERS_LABEL } from './latest-vouchers-format'
