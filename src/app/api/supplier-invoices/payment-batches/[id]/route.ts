import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getPaymentBatch } from '@/lib/payments/batch-operations'

/**
 * Batch detail: the batch row plus its items joined to the live invoice state
 * (status + remaining), so the view can show per-line settlement without any
 * stored progress that could go stale. Rules in lib/payments/batch-operations.ts.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payment_batch.get',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const outcome = await getPaymentBatch({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: a read has no dry run')
    return NextResponse.json({ data: { ...outcome.data.batch, items: outcome.data.items } })
  },
)
