import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'

/**
 * Accounts whose postings indicate EU B2B sales: 3108 goods, 3308 services,
 * 3107 triangulation. Same set the periodisk sammanställning report keys on.
 */
const EU_SALES_ACCOUNTS = ['3108', '3308', '3107']

/** How far back to look for EU sales postings. */
const LOOKBACK_MONTHS = 15

/**
 * GET /api/settings/eu-trade-signal
 *
 * Derived suggestion signal for the tax settings page: companies with EU
 * sales in the ledger have a statutory periodisk sammanställning obligation
 * (SFL 35 kap.), but the driving settings flags are opt-in and easily left
 * off. The settings UI uses this to prompt the user to confirm EU trade and
 * PS registration; it never flips the flags itself.
 */
export const GET = withRouteContext(
  'settings.eu_trade_signal',
  async (_request, { supabase, companyId }) => {
    const since = new Date()
    since.setMonth(since.getMonth() - LOOKBACK_MONTHS)
    const sinceStr = since.toISOString().split('T')[0]

    const lines = await fetchEntryLines<{ account_number: string }>({
      supabase,
      lineColumns: 'account_number',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .in('status', ['posted', 'reversed'])
          .gte('entry_date', sinceStr),
      filterLines: (q: EntryLinesQuery) => q.in('account_number', EU_SALES_ACCOUNTS),
    })

    return NextResponse.json({ data: { has_eu_sales: lines.length > 0 } })
  },
)
