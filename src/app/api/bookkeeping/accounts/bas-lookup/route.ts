import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface ChartRow {
  account_number: string
  account_name: string
  account_class: number | null
  account_type: string | null
  is_active: boolean | null
}

/**
 * GET /api/bookkeeping/accounts/bas-lookup?numbers=5010,2641
 *
 * Resolves account numbers to a human-readable label plus whether they can be
 * activated at all. Used by ActivateAccountsDialog to render the list before
 * the user confirms.
 *
 * Two sources, company first:
 *   1. The company's own chart_of_accounts. A row here is activatable even if
 *      it isn't a standard BAS account (custom accounts) and even if it is
 *      currently deactivated: POST /accounts/activate reactivates it. The
 *      company's own account_name wins, since it may have been renamed.
 *   2. The static BAS reference, for accounts not yet added to the chart.
 *
 * Numbers in neither source are returned with account_name=null and
 * known=false so the UI can flag them as non-BAS and offer "create".
 *
 * `in_chart` / `is_active` let callers tell "will be added" from "will be
 * reactivated". Consulting the company chart is why this route resolves a
 * company context (it was a pure in-memory reference lookup before).
 */
export const GET = withRouteContext('bookkeeping.accounts.bas-lookup', async (request, ctx) => {
  const { supabase, companyId } = ctx

  const { searchParams } = new URL(request.url)
  const raw = searchParams.get('numbers') || ''
  const numbers = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
  if (numbers.length === 0) {
    return NextResponse.json({ data: [] })
  }
  // The BAS catalogue is ~1,276 accounts — anything past that is abuse.
  if (numbers.length > 2000) {
    return NextResponse.json({ error: 'Too many account numbers' }, { status: 400 })
  }

  // Paginated: `numbers` can hold up to 2000 entries and PostgREST silently
  // caps an unranged select at 1000 rows. A truncated chart read would report
  // accounts that ARE in the chart as known:false / in_chart:false, so the
  // dialog would offer "create" for an account that already exists.
  let chartRows: ChartRow[]
  try {
    chartRows = await fetchAllRows<ChartRow>(
      ({ from, to }) =>
        supabase
          .from('chart_of_accounts')
          .select('account_number, account_name, account_class, account_type, is_active')
          .eq('company_id', companyId)
          .in('account_number', numbers)
          // Paging is only stable under a unique total order.
          .order('account_number', { ascending: true })
          .range(from, to),
      { dedupeBy: (row) => row.account_number },
    )
  } catch (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  const inChart = new Map(chartRows.map((row) => [row.account_number, row]))

  const data = numbers.map((num) => {
    const own = inChart.get(num)
    if (own) {
      return {
        account_number: own.account_number,
        account_name: own.account_name,
        account_class: own.account_class,
        account_type: own.account_type,
        known: true,
        in_chart: true,
        is_active: own.is_active,
      }
    }

    const ref = getBASReference(num)
    if (!ref) {
      return { account_number: num, account_name: null, known: false, in_chart: false, is_active: false }
    }
    return {
      account_number: ref.account_number,
      account_name: ref.account_name,
      account_class: ref.account_class,
      account_type: ref.account_type,
      known: true,
      in_chart: false,
      is_active: false,
    }
  })

  return NextResponse.json({ data })
})
