import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getPosClearingBalance } from '@/lib/pos-sales/clearing-balance'
import { PosClearingBalanceQuerySchema } from '@/lib/pos-sales/schemas'

/**
 * GET ?as_of=YYYY-MM-DD: the till's card and Swish money not yet in the
 * bank: the ledger balance of the accounts they clear on, and the card and
 * Swish of the days not booked yet. Rules in lib/pos-sales/clearing-balance.ts,
 * shared with the operation pos-sales.clearing-balance. Read-only.
 */
export const GET = withRouteContext('pos_sales.clearing_balance', async (request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const query = validateQuery(request, PosClearingBalanceQuerySchema, { log, operation: 'pos_sales.clearing_balance' })
  if (!query.success) return query.response
  const outcome = await getPosClearingBalance({ supabase, companyId: companyId!, userId: user.id, log }, query.data)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) throw new Error('unreachable: a read')
  return NextResponse.json({ data: outcome.data })
})
