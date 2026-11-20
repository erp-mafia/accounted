import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { getAccountStatus } from '@/lib/reconciliation/service'
import { ISO_DATE_RE } from '@/lib/invariants'

const DATE = ISO_DATE_RE

/**
 * GET /api/reconciliation/accounts/{accountKey}
 *
 * The bridge for one account (plus, for the skattekonto, the item buckets the
 * page renders under it). Same service function as v1 and MCP.
 */
export const GET = withRouteContext<{ params: Promise<{ accountKey: string }> }>(
  'reconciliation.accounts.status',
  async (request, { supabase, companyId }, { params }) => {
    const { accountKey } = await params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return NextResponse.json({ error: 'Okänt konto' }, { status: 404 })
    }
    const { searchParams } = new URL(request.url)
    const dateFrom = searchParams.get('date_from') || null
    const dateTo = searchParams.get('date_to') || null
    if ((dateFrom && !DATE.test(dateFrom)) || (dateTo && !DATE.test(dateTo))) {
      return NextResponse.json({ error: 'Ogiltigt datum' }, { status: 400 })
    }
    const status = await getAccountStatus(supabase, companyId, accountKey, {
      windowFrom: dateFrom,
      windowTo: dateTo,
    })
    if (!status) {
      return NextResponse.json({ error: 'Okänt konto för det här företaget' }, { status: 404 })
    }
    return NextResponse.json({ data: status })
  },
)
