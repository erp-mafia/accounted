import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { PosDaysQuerySchema } from '@/lib/pos-sales/schemas'
import { listPosSalesDays } from '@/lib/pos-sales/service'

/**
 * The fetched POS business days, newest first, without receipts. Rules in
 * lib/pos-sales/service.ts, shared with the operation pos-sales.days-list.
 */
export const GET = withRouteContext('pos_sales.days.list', async (request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const query = validateQuery(request, PosDaysQuerySchema, { log, operation: 'pos_sales.days.list' })
  if (!query.success) return query.response
  const outcome = await listPosSalesDays({ supabase, companyId: companyId!, userId: user.id, log }, query.data)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) throw new Error('unreachable: a read')
  return NextResponse.json({ data: outcome.data })
})
