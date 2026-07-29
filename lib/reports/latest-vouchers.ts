import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { LatestVoucherPerSeries } from '@/types'

/**
 * Statuses that count as "bokförd" for the purposes of this line.
 *
 * `reversed` is included deliberately: a stornerad verifikat keeps its number
 * and still occupies its slot in the series, so leaving it out would report a
 * gap that does not exist. Drafts and cancelled entries carry
 * `voucher_number = 0` and are excluded by the `> 0` filter instead.
 */
const POSTED_STATUSES = ['posted', 'reversed'] as const

interface VoucherRow {
  id: string
  voucher_series: string | null
  voucher_number: number
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
 */
export async function getLatestPostedVouchers(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  window: { fromDate?: string; toDate: string }
): Promise<LatestVoucherPerSeries[]> {
  const rows = await fetchAllRows<VoucherRow>(
    ({ from, to }) => {
      let query = supabase
        .from('journal_entries')
        .select('id, voucher_series, voucher_number')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .in('status', POSTED_STATUSES)
        .gt('voucher_number', 0)
        .lte('entry_date', window.toDate)

      if (window.fromDate) {
        query = query.gte('entry_date', window.fromDate)
      }

      // Order on the PK: paging is only stable with a unique total order.
      return query.order('id', { ascending: true }).range(from, to)
    },
    { dedupeBy: (r) => r.id }
  )

  const maxBySeries = new Map<string, number>()
  for (const row of rows) {
    const series = row.voucher_series || 'A'
    const current = maxBySeries.get(series) ?? 0
    if (row.voucher_number > current) {
      maxBySeries.set(series, row.voucher_number)
    }
  }

  return [...maxBySeries.entries()]
    .map(([series, last_number]) => ({ series, last_number }))
    .sort((a, b) => a.series.localeCompare(b.series, 'sv'))
}

// Re-exported for convenience on server surfaces; the canonical home is the
// dependency-free format module, which client components import directly.
export { formatLatestVouchers, LATEST_VOUCHERS_LABEL } from './latest-vouchers-format'
