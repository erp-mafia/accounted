import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { SpendItemsQuerySchema } from '@/lib/spend/schemas'
import { listSpendItems } from '@/lib/spend/service'

/**
 * The received spend expenses, newest first, without the model. Rules in
 * lib/spend/service.ts, shared with the operation spend.items-list.
 */
export const GET = withRouteContext('spend.items.list', async (request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const query = validateQuery(request, SpendItemsQuerySchema, { log, operation: 'spend.items.list' })
  if (!query.success) return query.response
  const outcome = await listSpendItems({ supabase, companyId: companyId!, userId: user.id, log }, query.data)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) throw new Error('unreachable: a read')
  return NextResponse.json({ data: outcome.data })
})
