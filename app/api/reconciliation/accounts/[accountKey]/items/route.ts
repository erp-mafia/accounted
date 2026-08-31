import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { AccountKeySchema, ReconciliationItemBucketSchema } from '@/lib/reconciliation/schemas'
import { listAccountItems, MAX_ITEMS_LIMIT } from '@/lib/reconciliation/items'
import { ISO_DATE_RE } from '@/lib/invariants'

const DATE = ISO_DATE_RE

/**
 * GET /api/reconciliation/accounts/{accountKey}/items
 *
 * The rows behind one account's bridge, bucketed and paginated
 * (?bucket, ?date_from, ?date_to, ?limit, ?offset).
 */
export const GET = withRouteContext<{ params: Promise<{ accountKey: string }> }>(
  'reconciliation.accounts.items',
  async (request, { supabase, companyId }, { params }) => {
    const { accountKey } = await params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return NextResponse.json({ error: 'Okänt konto' }, { status: 404 })
    }
    const { searchParams } = new URL(request.url)
    const bucketRaw = searchParams.get('bucket')
    const bucket = bucketRaw ? ReconciliationItemBucketSchema.safeParse(bucketRaw) : null
    if (bucket && !bucket.success) {
      return NextResponse.json({ error: 'Ogiltig bucket' }, { status: 400 })
    }
    const dateFrom = searchParams.get('date_from') || null
    const dateTo = searchParams.get('date_to') || null
    if ((dateFrom && !DATE.test(dateFrom)) || (dateTo && !DATE.test(dateTo))) {
      return NextResponse.json({ error: 'Ogiltigt datum' }, { status: 400 })
    }
    const limit = Math.min(Number(searchParams.get('limit') ?? 50) || 50, MAX_ITEMS_LIMIT)
    const offset = Math.max(0, Number(searchParams.get('offset') ?? 0) || 0)

    const result = await listAccountItems(supabase, companyId, accountKey, {
      bucket: bucket?.success ? bucket.data : undefined,
      windowFrom: dateFrom,
      windowTo: dateTo,
      limit,
      offset,
    })
    if (!result) {
      return NextResponse.json({ error: 'Okänt konto för det här företaget' }, { status: 404 })
    }
    return NextResponse.json({ data: result })
  },
)
