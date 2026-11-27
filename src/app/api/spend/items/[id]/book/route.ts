import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bookSpendItem } from '@/lib/spend/book-item'
import { SpendBookBodySchema } from '@/lib/spend/schemas'

/**
 * Book one spend expense as its verifikat, with its receipts linked. The
 * lines are the server's, from the stored expense and the connection's
 * settings; expected_raw_sha256 pins the version the person reviewed. Rules
 * in lib/spend/book-item.ts, shared with the operation spend.item-book.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'spend.item.book',
  async (request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params
    const body = await validateBody(request, SpendBookBodySchema, { log, operation: 'spend.item.book' })
    if (!body.success) return body.response
    const opLog = log.child({ itemId: id })
    const outcome = await bookSpendItem({ supabase, companyId: companyId!, userId: user.id, log: opLog }, { item_id: id, ...body.data })
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) })
  },
  { requireWrite: true, uuidParams: { id: 'SPEND_ITEM_NOT_FOUND' } },
)
