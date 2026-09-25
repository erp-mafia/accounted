import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { splitTransactions } from '@/lib/skatteverket/skattekonto-buckets'
import { findMatchSuggestionsBulk } from '@/lib/skatteverket/skattekonto-match'
import { attachBookingSuggestions } from '@/lib/skatteverket/skattekonto-booking'

ensureInitialized()

/**
 * Skattekonto transactions, read from the core table.
 *
 * Why this is core and not the Skatteverket extension's route: a
 * skattekontoutdrag file import writes skattekonto_transactions without any
 * connection to Skatteverket, and the extension dispatcher refuses every
 * route of a flagged-off extension before it looks at which route was asked
 * for. So on an installation with SKATTEVERKET_ENABLED unset, the rows a
 * company imported itself were unreadable: the page's only read path answered
 * 503 and it rendered "Kunde inte hämta skattekontot" over data it already
 * had. The read path now follows what the data depends on (a core table)
 * rather than where the feature came from.
 *
 * Saldo stays with the extension: that genuinely is a Skatteverket figure and
 * there is nothing local to fall back on.
 *
 * Same envelope as the extension route so the page consumes one shape.
 */
export const GET = withRouteContext('skattekonto.transactions.list', async (request, { supabase, companyId }) => {
  const url = new URL(request.url)
  const from = url.searchParams.get('from')
  const includeIgnoredParam = url.searchParams.get('include_ignored')
  const includeIgnored = includeIgnoredParam === '1' || includeIgnoredParam === 'true'

  let query = supabase
    .from('skattekonto_transactions')
    .select('*')
    .eq('company_id', companyId)
    .order('transaktionsdatum', { ascending: false })

  if (from) query = query.gte('transaktionsdatum', from)

  const { data, error } = await query
  // Thrown, not returned: withRouteContext maps it to the canonical envelope
  // rather than handing a Postgres message to the page.
  if (error) throw error

  const rows = data ?? []
  const today = new Date().toISOString().slice(0, 10)
  const { booked, overdue, upcoming, ignored } = splitTransactions(rows, today)

  // Both enrichments read core tables only (journal entries, the chart, the
  // fiscal periods), so an installation without the integration still gets
  // the same suggestions it would get with it.
  const suggestions = await findMatchSuggestionsBulk(
    supabase,
    companyId,
    booked.map((r) => ({
      id: r.id,
      transaktionsdatum: r.transaktionsdatum,
      belopp_skatteverket: Number(r.belopp_skatteverket),
      journal_entry_id: r.journal_entry_id,
    })),
  )
  const withBookingSuggestions = await attachBookingSuggestions(supabase, companyId, booked)

  return NextResponse.json({
    data: {
      booked: withBookingSuggestions.map((r) => ({
        ...r,
        match_suggestion: suggestions.get(r.id) ?? null,
      })),
      overdue,
      upcoming,
      ignored_count: ignored.length,
      ...(includeIgnored ? { ignored } : {}),
    },
  })
})
