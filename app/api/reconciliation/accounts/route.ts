import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'
import { ISO_DATE_RE } from '@/lib/invariants'

const DATE = ISO_DATE_RE

/**
 * GET /api/reconciliation/accounts
 *
 * The side list of the Avstämning page: every account with an outside truth
 * and its status. Same service function the v1 API and the MCP resource use.
 * ?date_from / ?date_to scope the bank bridge; ?with_status=false skips the
 * per-account status reads when only the list is needed.
 */
export const GET = withRouteContext(
  'reconciliation.accounts.list',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const dateFrom = searchParams.get('date_from') || undefined
    const dateTo = searchParams.get('date_to') || undefined
    if ((dateFrom && !DATE.test(dateFrom)) || (dateTo && !DATE.test(dateTo))) {
      return NextResponse.json({ error: 'Ogiltigt datum' }, { status: 400 })
    }
    const accounts = await listReconciliationAccounts(supabase, companyId, {
      windowFrom: dateFrom,
      windowTo: dateTo,
      withStatus: searchParams.get('with_status') !== 'false',
    })
    return NextResponse.json({ data: { accounts } })
  },
)
